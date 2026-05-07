// Supabase Edge Function: process-photo
// Поддерживает два режима:
//   audit (default with originalImage+processedImage):
//     Принимает: { mode: "audit", originalImage, processedImage, userId?, mimeType? }
//     Сохраняет оба изображения в storage, пишет запись в `photos`, возвращает
//     { id, shortPhotoKey, originalPath, processedPath, serverChecks }.
//     НЕ вызывает Gemini — обработка делается на клиенте (mediapipe selfie_segmentation).
//   process (legacy, when only `image` provided):
//     Принимает: { image, userId?, mimeType? }
//     Шлёт в Gemini, retry 2x с backoff, timeout 60s, сохраняет в storage,
//     возвращает обработанное изображение. Оставлено для обратной совместимости.
//
// Логи: structured JSON.

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
    const { mode, mimeType = "image/jpeg" } = body;
    userId = body.userId ?? "anonymous";

    log("request_start", { user_id: userId, mime: mimeType, mode: mode ?? "process" });

    const id = crypto.randomUUID();
    const ts = new Date().toISOString().slice(0, 10);
    const originalPath  = `${ts}/${userId}/${id}_original.jpg`;
    const processedPath = `${ts}/${userId}/${id}_processed.jpg`;
    const shortPhotoKey = id.replace(/-/g, "").slice(0, 10);
    const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const decode = (s: string) => Uint8Array.from(atob(s.replace(/^data:image\/\w+;base64,/, "")),
                                                  c => c.charCodeAt(0));

    // ── audit mode: store both images, no AI call ─────────────────
    if (mode === "audit") {
      const { originalImage, processedImage } = body;
      if (!originalImage || !processedImage) {
        return json({ error: "Missing originalImage or processedImage" }, 400);
      }
      const origBytes = decode(originalImage);
      const procBytes = decode(processedImage);

      const t1 = performance.now();
      await Promise.all([
        supa.storage.from("originals").upload(originalPath, origBytes,
          { contentType: mimeType, upsert: false }),
        supa.storage.from("processed").upload(processedPath, procBytes,
          { contentType: mimeType, upsert: false }),
      ]);
      await supa.from("photos").insert({
        id, telegram_user_id: userId,
        original_path: originalPath,
        processed_path: processedPath,
        mime_type: mimeType,
      });

      log("audit_done", {
        user_id: userId,
        latency_ms: Math.round(performance.now() - t1),
        bytes_in: origBytes.length, bytes_out: procBytes.length,
        total_latency_ms: Math.round(performance.now() - reqStart),
      });

      return json({
        id, shortPhotoKey,
        originalPath, processedPath,
        serverChecks: [
          { label: "PhotoStored", isValid: true, canBeFixed: false, isMandatory: false,
            meta: { bytes_in: origBytes.length, bytes_out: procBytes.length } },
        ],
      });
    }

    // ── legacy process mode (Gemini) ──────────────────────────────
    const { image } = body;
    if (!image) return json({ error: "Missing 'image' (base64) in body" }, 400);

    const b64 = image.replace(/^data:image\/\w+;base64,/, "");
    const inputBytes = decode(image);

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
