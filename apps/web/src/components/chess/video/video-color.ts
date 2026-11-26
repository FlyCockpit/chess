/**
 * RGBA → I420 (planar 4:2:0), BT.709 limited ("TV") range: what ffprobe calls
 * yuv420p, the pixel format X asks for. Encoding the canvas directly gives
 * full-range (yuvj420p) H.264 in Chromium, so the worker converts each scene
 * once and hands the encoder frames tagged with this colour space.
 */
export const I420_COLOR_SPACE = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  fullRange: false,
} as const satisfies VideoColorSpaceInit;

export function rgbaToI420(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  if (width % 2 || height % 2) throw new Error("I420 needs even dimensions");
  const lumaSize = width * height;
  const out = new Uint8Array(lumaSize * 1.5);
  const uOffset = lumaSize;
  const vOffset = lumaSize + lumaSize / 4;
  const halfWidth = width / 2;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = ((y + dy) * width + x + dx) * 4;
          const pr = rgba[p] as number;
          const pg = rgba[p + 1] as number;
          const pb = rgba[p + 2] as number;
          out[(y + dy) * width + x + dx] = Math.round(16 + 0.1826 * pr + 0.6142 * pg + 0.062 * pb);
          r += pr;
          g += pg;
          b += pb;
        }
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const c = (y / 2) * halfWidth + x / 2;
      out[uOffset + c] = Math.round(128 - 0.1006 * r - 0.3386 * g + 0.4392 * b);
      out[vOffset + c] = Math.round(128 + 0.4392 * r - 0.3989 * g - 0.0403 * b);
    }
  }
  return out;
}
