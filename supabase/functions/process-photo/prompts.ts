// Биометричный промпт согласно требованиям заказчика.
// НЕ МОДИФИЦИРОВАТЬ без согласования с product owner — каждое изменение
// требует прогона бенчмарка face similarity.

export const BIOMETRIC_PROMPT_EN = `Process this photo into a standard biometric document photo with 35mm x 45mm proportions (ratio 7:9, portrait orientation).

CRITICAL RULES — DO NOT VIOLATE:
- DO NOT alter, redraw, regenerate, reshape, or modify the person's face in any way.
- DO NOT change facial features, skin tone, eye color, eye shape, nose, lips, jawline, ears, hair texture, or hair color.
- DO NOT smooth, beautify, slim, or "enhance" the face. Preserve every freckle, mole, scar, wrinkle, and natural skin texture exactly as in the original.
- DO NOT change the person's identity. The output face must be 100% identical to the input face — pixel-level fidelity to facial geometry and features is required.
- DO NOT add or remove glasses, makeup, jewelry, or facial hair.

ALLOWED EDITS ONLY:
1. CROP to 35x45mm document standard:
   - Head and top of shoulders visible.
   - Top of head approximately 3-5mm from the top edge.
   - Face (from chin to crown) occupies 70-80% of the frame height (approx. 32-36mm).
   - Eyes positioned roughly at the upper third of the frame.
   - Head centered horizontally, vertical and looking straight at camera.
2. REPLACE the background with a uniform plain light background (pure white #FFFFFF or very light neutral gray #F2F2F2), evenly lit, no shadows, no gradients, no texture.
3. LIGHT TECHNICAL RETOUCH ONLY:
   - Even out exposure and remove harsh shadows on the face.
   - Correct white balance for natural skin tone (without changing the actual skin color).
   - Remove dust, sensor spots, or stray hairs ON THE BACKGROUND only — never on the face.
4. Output sharpness suitable for print at 300 DPI.

Output: a clean, ICAO/Schengen-style biometric portrait, ready for printing on a Polish/EU identity document, passport, residence card, or visa application.`;
