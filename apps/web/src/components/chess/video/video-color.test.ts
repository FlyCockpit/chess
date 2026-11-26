import { describe, expect, it } from "vitest";
import { rgbaToI420 } from "./video-color";

function solid(r: number, g: number, b: number, width = 4, height = 2) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([r, g, b, 255], i * 4);
  return rgbaToI420(rgba, width, height);
}

describe("rgbaToI420", () => {
  it("maps black and white to the limited range 16–235 with neutral chroma", () => {
    expect([...solid(0, 0, 0)]).toEqual([16, 16, 16, 16, 16, 16, 16, 16, 128, 128, 128, 128]);
    expect([...solid(255, 255, 255)]).toEqual([
      235, 235, 235, 235, 235, 235, 235, 235, 128, 128, 128, 128,
    ]);
  });

  it("uses BT.709 coefficients", () => {
    // Pure red: Y 63, Cb 102, Cr 240 (ITU-R BT.709, 8-bit limited range).
    const red = solid(255, 0, 0);
    expect(red[0]).toBe(63);
    expect(red[8]).toBe(102);
    expect(red[10]).toBe(240);
  });

  it("averages each 2×2 block for chroma and lays planes out Y, U, V", () => {
    const rgba = new Uint8ClampedArray(2 * 2 * 4);
    rgba.set([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const out = rgbaToI420(rgba, 2, 2);
    expect(out).toHaveLength(6);
    expect([...out.slice(0, 4)]).toEqual([235, 235, 16, 16]);
    expect([...out.slice(4)]).toEqual([128, 128]);
  });

  it("refuses odd sizes", () => {
    expect(() => rgbaToI420(new Uint8ClampedArray(12), 3, 1)).toThrow();
  });
});
