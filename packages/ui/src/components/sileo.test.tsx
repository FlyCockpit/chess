import { beforeEach, describe, expect, it, vi } from "vitest";

// The facade calls sileo directly (no lazy chunk in this app). The stand-in
// records each call and, like sileo, returns the id it was given.
const backend = vi.hoisted(() => {
  const method = () => vi.fn((options: { id?: string }) => options.id ?? "sileo-default");
  return {
    show: method(),
    success: method(),
    error: method(),
    info: method(),
    warning: method(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  };
});
vi.mock("sileo", () => ({ sileo: backend, Toaster: () => null }));
vi.mock("sileo/styles.css", () => ({}));

const { toast } = await import("./sileo");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toast facade", () => {
  it("maps each method and its options onto sileo", () => {
    const onClick = vi.fn();
    toast.success("Saved");
    toast.error("Failed", { duration: 5000, action: { label: "Retry", onClick } });
    toast.message("Heads up");

    expect(backend.success).toHaveBeenCalledWith({ id: expect.any(String), title: "Saved" });
    expect(backend.error).toHaveBeenCalledWith({
      id: expect.any(String),
      title: "Failed",
      duration: 5000,
      button: { title: "Retry", onClick },
    });
    expect(backend.show).toHaveBeenCalledWith({ id: expect.any(String), title: "Heads up" });
  });

  it("gives every toast its own id so two toasts stack instead of merging", () => {
    // sileo defaults every toast to id "sileo-default" and replaces in place.
    const first = toast.error("That wasn't found.");
    const second = toast.error("That wasn't found.");

    expect(first).not.toBe(second);
    expect(first).not.toBe("sileo-default");
    expect(backend.error.mock.calls.map(([options]) => options.id)).toEqual([first, second]);
  });

  it("repeats a long message in the description so the clipped pill loses nothing", () => {
    const long = "That code didn't work. Check your authenticator and try again.";

    toast.error(long);
    toast.success("Saved");

    expect(backend.error).toHaveBeenCalledWith(
      expect.objectContaining({ title: long, description: long }),
    );
    expect(backend.success.mock.calls[0]?.[0]).not.toHaveProperty("description");
  });

  it("decides by the measured width, not the character count", async () => {
    const { titleOverflowsPill, pillTitleBudget } = await import("./sileo");
    // ~8px per glyph at a 16px root: 36 characters fit, 36 wide glyphs don't.
    const at16 = (perChar: number) => (m: string) => ({
      width: m.length * perChar,
      budget: pillTitleBudget(16),
    });
    expect(pillTitleBudget(16)).toBe(292);
    expect(titleOverflowsPill("a".repeat(36), at16(6.5))).toBe(false);
    expect(titleOverflowsPill("W".repeat(30), at16(11))).toBe(true);
    // At a 24px root the font grows but sileo's pill does not: a 36-character
    // message that fit at 16px no longer does.
    const at24 = (m: string) => ({ width: m.length * 6.5 * 1.5, budget: pillTitleBudget(24) });
    expect(titleOverflowsPill("We've emailed you a verification code", at24)).toBe(true);
  });

  it("falls back to a length rule when nothing can be measured", async () => {
    const { titleOverflowsPill } = await import("./sileo");
    expect(titleOverflowsPill("Saved", () => null)).toBe(false);
    expect(titleOverflowsPill("x".repeat(41), () => null)).toBe(true);
  });
});

describe("defaultToastPosition", () => {
  it("keeps phones centred and moves wide screens off centred form actions", async () => {
    const { defaultToastPosition } = await import("./sileo");
    expect(defaultToastPosition(false)).toBe("bottom-center");
    expect(defaultToastPosition(true)).toBe("bottom-right");
  });
});
