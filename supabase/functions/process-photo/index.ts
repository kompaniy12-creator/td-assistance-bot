// Supabase Edge Function: process-photo
// Принимает: { image: base64 (data-URL или чистый), userId?: string, mimeType?: string }
// Возвращает: { id, image: base64-data-url, originalPath, processedPath }
//
// Pipeline:
// 1. Сохраняет оригинал в bucket 'originals'
// 2. Шлёт в Google Gemini 2.5 Flash Image (Nano Banana) с retry (2 попытки, backoff 1s/3s) и timeout 60s
// 3. Сохраняет результат в bucket 'processed'
// 4. Записывает запись в таблицу photos
// 5. Возвращает результат фронтенду
//
// Логи: structured JSON (user_id, stage, latency_ms, status). Никакого fallback на другие модели —
// при провале возвращаем ошибку наверх (per ТЗ §6.2).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { BIOMETRIC_PROMPT_EN } from "./prompts.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL   = Deno.env.get("GEMINI_MODEL")    ?? "gemini-2.5-flash-image";
const GEMINI_TIMEOUT = Number(Deno.env.get("GEMINI_TIMEOUT_SECONDS") ?? "60") * 1000;
const RETRY_DELAYS_MS = [1000, 3000];   // 2 retries: 1s, then 3s

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" }
  });

// Structured JSON log line (one event per call to log).
function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Gemini call with timeout. Throws Error with .status (HTTP code) on non-OK.
async function callGemini(b64: string, mimeType: string): Promise<{ data: string; mime: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const ctrl = new AbortController();
  const tHandle = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: BIOMETRIC_PROMPT_EN },
            { inline_data: { mime_type: mimeType, data: b64 } }
          ]
        }],
        generationConfig: { responseModalities: ["IMAGE"] }
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tHandle);
  }

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`) as Error & { status: number; raw: string };
    err.status = res.status;
    err.raw = errText;
    throw err;
  }

  const result = await res.json();
  const parts  = result?.candidates?.[0]?.content?.parts ?? [];
  const imgPart = parts.find((p: any) => p.inline_data || p.inlineData);
  if (!imgPart) {
    throw new Error("Gemini did not return an image part");
  }
  const data = imgPart.inline_data?.data ?? imgPart.inlineData?.data;
  const mime = imgPart.inline_data?.mime_type ?? imgPart.inlineData?.mimeType ?? "image/jpeg";
  return { data, mime };
}

// Wrap callGemini with retry (2 retries, exponential backoff).
async function callGeminiWithRetry(b64: string, mimeType: string, userId: string): Promise<{ data: string; mime: string }> {
  let lastErr: any = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const t0 = performance.now();
    try {
      const out = await callGemini(b64, mimeType);
      log("gemini_ok", { user_id: userId, attempt, latency_ms: Math.round(performance.now() - t0), model: GEMINI_MODEL });
      return out;
    } catch (e: any) {
      const status = e?.status ?? 0;
      lastErr = e;
      log("gemini_error", {
        user_id: userId,
        attempt,
        latency_ms: Math.round(performance.now() - t0),
        status,
        message: String(e?.message ?? e).slice(0, 300),
      });
      // 4xx (other than 429) — non-retriable
      if (status >= 400 && status < 500 && status !== 429) break;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }
  throw lastErr ?? new Error("Gemini failed after retries");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const reqStart = performance.now();
  if (!GEMINI_API_KEY) {
    log("config_error", { error: "GEMINI_API_KEY not set" });
    return json({ error: "GEMINI_API_KEY not configured" }, 500);
  }

  let userId = "anonymous";
  try {
    const body = await req.json();
    const { image, mimeType = "image/jpeg" } = body;
    userId = body.userId ?? "anonymous";

    if (!image) return json({ error: "Missing 'image' (base64) in body" }, 400);

    log("request_start", { user_id: userId, mime: mimeType });

    // Strip data: URL prefix if present
    const b64 = image.replace(/^data:image\/\w+;base64,/, "");
    const inputBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    const id = crypto.randomUUID();
    const ts = new Date().toISOString().slice(0, 10);
    const originalPath  = `${ts}/${userId}/${id}_original.jpg`;
    const processedPath = `${ts}/${userId}/${id}_processed.jpg`;

    const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1) Save original
    const t1 = performance.now();
    await supa.storage.from("originals").upload(originalPath, inputBytes, {
      contentType: mimeType, upsert: false
    });
    log("upload_original", { user_id: userId, latency_ms: Math.round(performance.now() - t1), bytes: inputBytes.length });

    // 2) Call Gemini (with retry + timeout)
    let outData: string, outMime: string;
    try {
      const out = await callGeminiWithRetry(b64, mimeType, userId);
      outData = out.data;
      outMime = out.mime;
    } catch (e: any) {
      const status = e?.status ?? 0;
      if (status === 429) {
        return json({
          error: "AI quota exceeded. Try again later.",
          code: "QUOTA_EXCEEDED",
          detail: String(e?.raw ?? e?.message ?? "").slice(0, 200),
        }, 429);
      }
      return json({
        error: `Gemini failed`,
        code: "GEMINI_ERROR",
        detail: String(e?.message ?? e).slice(0, 200),
      }, 502);
    }

    const outBytes = Uint8Array.from(atob(outData), c => c.charCodeAt(0));

    // 3) Save processed
    const t3 = performance.now();
    await supa.storage.from("processed").upload(processedPath, outBytes, {
      contentType: outMime, upsert: false
    });
    log("upload_processed", { user_id: userId, latency_ms: Math.round(performance.now() - t3), bytes: outBytes.length });

    // 4) Save record
    await supa.from("photos").insert({
      id, telegram_user_id: userId,
      original_path: originalPath,
      processed_path: processedPath,
      mime_type: outMime,
    });

    log("request_done", {
      user_id: userId,
      total_latency_ms: Math.round(performance.now() - reqStart),
      bytes_in:  inputBytes.length,
      bytes_out: outBytes.length,
    });

    // Short ID for support — first 10 hex chars of UUID without dashes (à la PhotoAid).
    const shortPhotoKey = id.replace(/-/g, "").slice(0, 10);

    // Server-side checks (taxonomy). The full result list is assembled client-side
    // by merging these with pre-AI validation gates and post-AI similarity/output checks.
    const serverChecks = [
      {
        label: "AiProcessed",
        isValid: true,
        canBeFixed: false,
        isMandatory: true,
        meta: { bytes: outBytes.length, mime: outMime, model: GEMINI_MODEL },
      },
    ];

    // 5) Return to client
    return json({
      id,
      shortPhotoKey,
      image: `data:${outMime};base64,${outData}`,
      mimeType: outMime,
      originalPath,
      processedPath,
      serverChecks,
    });
  } catch (e: any) {
    log("request_error", {
      user_id: userId,
      total_latency_ms: Math.round(performance.now() - reqStart),
      message: String(e?.message ?? e).slice(0, 300),
    });
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
