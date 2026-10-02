// Long-edge cap (px) for images sent to the VLM/Claude. Ported from
// renderer/redact.js's MODEL_IMAGE_MAX_DIMENSION -- shared here because
// Phase 2's main-process `generate` handler checks it (proves the renderer's
// downscale ran) and Phase 3 ports the same constant into redact.ts.
export const MODEL_IMAGE_MAX_DIMENSION = 1280;
