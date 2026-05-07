// Биометричный промпт согласно ТЗ §6.1 (face preservation as highest priority).
// НЕ МОДИФИЦИРОВАТЬ без согласования с product owner — каждое изменение
// требует прогона бенчмарка face similarity.

export const BIOMETRIC_PROMPT_EN = `Process this photo into a biometric document photo that complies with the Polish residence permit (zezwolenie na pobyt) requirements per Rozporządzenie MSWiA.

CRITICAL — FACE PRESERVATION (HIGHEST PRIORITY):
- DO NOT alter, redraw, regenerate, reshape, or modify the person's face.
- DO NOT change facial features, skin tone, eye color/shape, nose, lips, jawline, ears, hair texture, or hair color.
- DO NOT smooth, beautify, slim, age, de-age, or "enhance" the face.
- Preserve every freckle, mole, scar, wrinkle, pore, and natural skin texture exactly as in the source.
- Output face must be 100% identical to source — pixel-level fidelity to facial geometry, proportions, and identity is mandatory.
- DO NOT add, remove, or alter glasses, makeup, jewelry, piercings, or facial hair.
- Treat this as a non-generative edit: inpainting is allowed ONLY outside the head-and-shoulders silhouette.

COMPOSITION (35x45 mm, 7:9 portrait):
- Frame from top of head down to upper shoulders.
- Face occupies 70–80% of total photo height.
- Head centered horizontally, en face, no tilt.
- Eye line strictly parallel to top edge.
- Eyes open, both pupils sharp and visible.
- Hair must not cover eyes, eyebrows, or face contour.
- Mouth closed, neutral expression.
- Natural skin color.

BACKGROUND:
- Replace with uniform off-white #FCFCFC (PhotoAid / Polish ICAO practice — softer than pure white to avoid blown-out highlights when printed).
- Evenly lit, no shadows, no gradients, no texture.
- Clean edge along hair/shoulders, no halo.

ALLOWED RETOUCH ONLY:
- Even out exposure, soften harsh facial shadows (without changing skin color/features).
- White balance correction for natural skin tone.
- Remove dust/spots ONLY on background, never on face.
- Sharpen for 300 DPI print.

OUTPUT: single image, 35:45 aspect ratio, ICAO/Schengen-grade biometric portrait, ready for Polish Urząd Wojewódzki submission.`;
