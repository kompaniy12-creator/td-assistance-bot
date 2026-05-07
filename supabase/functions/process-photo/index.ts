// Supabase Edge Function: process-photo
// Принимает: { image: base64, userId?: string, mimeType?: string }
// Возвращает: { image: base64-data-url, originalPath, processedPath }
//
// Делает:
// 1. Сохраняет оригинал в bucket 'originals'
// 2. Шлёт в Google Gemini 2.5 Flash Image (Nano Banana)
// 3. Сохраняет результат в bucket 'processed'
// 4. Записывает запись в таблицу photos
// 5. Возвращает результат фронтенду

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL   = "gemini-2.5-flash-image-preview";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PROMPT = `Edit this photo to meet Polish biometric residence permit ID photo standards (35×45 mm).

REQUIREMENTS:
- Replace background with a uniform light gray (#EEEEEE) solid color, smooth and seamless, no shadows behind person
- Keep the person's face EXACTLY as it is — same identity, exact same facial features, expression, hairstyle, clothing
- Apply only subtle professional retouching: smooth out minor skin blemishes, even out skin tone slightly, reduce harsh shadows on the face
- Keep natural skin texture — do not over-smooth, do not change face shape, do not stylize
- Adjust lighting if needed: even, soft, frontal lighting on the face; remove harsh side shadows
- Keep the same composition (head + shoulders) and same crop dimensions
- Output a high-resolution, photo-realistic result that looks like a professional ID photograph

DO NOT:
- Change the person's identity, age, ethnicity, or facial features
- Add accessories, change hairstyle, change clothing
- Make the photo cartoonish, painted, or stylized
- Add text, logos, or watermarks

Output only the edited photo.`;

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" }
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not configured" }, 500);

  try {
    const { image, mimeType = "image/jpeg", userId = "anonymous" } = await req.json();
    if (!image) return json({ error: "Missing 'image' (base64) in body" }, 400);

    // Strip data: URL prefix if present
    const b64 = image.replace(/^data:image\/\w+;base64,/, "");
    const inputBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    const id = crypto.randomUUID();
    const ts = new Date().toISOString().slice(0, 10);
    const originalPath  = `${ts}/${userId}/${id}_original.jpg`;
    const processedPath = `${ts}/${userId}/${id}_processed.jpg`;

    const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1) Save original
    await supa.storage.from("originals").upload(originalPath, inputBytes, {
      contentType: mimeType, upsert: false
    });

    // 2) Call Gemini (Nano Banana)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const gRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mimeType, data: b64 } }
          ]
        }],
        generationConfig: { responseModalities: ["IMAGE"] }
      })
    });

    if (!gRes.ok) {
      const errText = await gRes.text();
      console.error("Gemini error:", gRes.status, errText.slice(0, 500));
      return json({ error: `Gemini API ${gRes.status}: ${errText.slice(0, 300)}` }, 502);
    }

    const result = await gRes.json();
    const parts  = result?.candidates?.[0]?.content?.parts ?? [];
    const imgPart = parts.find((p: any) => p.inline_data || p.inlineData);
    if (!imgPart) {
      console.error("No image in Gemini response:", JSON.stringify(result).slice(0, 800));
      return json({ error: "Gemini did not return an image" }, 502);
    }

    const outData = imgPart.inline_data?.data ?? imgPart.inlineData?.data;
    const outMime = imgPart.inline_data?.mime_type ?? imgPart.inlineData?.mimeType ?? "image/jpeg";
    const outBytes = Uint8Array.from(atob(outData), c => c.charCodeAt(0));

    // 3) Save processed
    await supa.storage.from("processed").upload(processedPath, outBytes, {
      contentType: outMime, upsert: false
    });

    // 4) Save record
    await supa.from("photos").insert({
      id, telegram_user_id: userId,
      original_path: originalPath,
      processed_path: processedPath,
      mime_type: outMime,
    });

    // 5) Return to client
    return json({
      id,
      image: `data:${outMime};base64,${outData}`,
      mimeType: outMime,
      originalPath,
      processedPath
    });
  } catch (e) {
    console.error("process-photo error:", e);
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
