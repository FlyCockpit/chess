import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ verifyPassword: vi.fn(), decrypt: vi.fn(), generate: vi.fn() }));
vi.mock("./index.js", () => ({
  passwordPepper: { verify: state.verifyPassword },
  auth: {
    $context: Promise.resolve({ secretConfig: "test-secret-config" }),
    api: { generateTOTP: state.generate },
  },
}));
vi.mock("better-auth/crypto", () => ({ symmetricDecrypt: state.decrypt }));
const { verifyRunnerLimitStepUp, runnerStepUpSchema } = await import("./runner-step-up.js");
beforeEach(() => {
  vi.resetAllMocks();
  state.verifyPassword.mockResolvedValue(true);
  state.decrypt.mockResolvedValue("otp-secret");
  state.generate.mockResolvedValue({ code: "123456" });
});
afterEach(() => vi.useRealTimers());
describe("fresh runner credential verification", () => {
  it("uses the configured peppered password verifier and refuses missing/passwordless credentials", async () => {
    const verification = { method: "password" as const, password: "typed-password" };
    expect(await verifyRunnerLimitStepUp(verification, { password: "sealed-hash" })).toBe(true);
    expect(state.verifyPassword).toHaveBeenCalledWith({
      hash: "sealed-hash",
      password: "typed-password",
    });
    expect(await verifyRunnerLimitStepUp(verification, {})).toBe(false);
    state.verifyPassword.mockResolvedValue(false);
    expect(await verifyRunnerLimitStepUp(verification, { password: "sealed-hash" })).toBe(false);
  });
  it("uses Better-Auth's current OTP generation and constant-time equality without a trusted-device shortcut", async () => {
    expect(
      await verifyRunnerLimitStepUp(
        { method: "totp", code: "123456" },
        { totpSecret: "sealed-secret" },
      ),
    ).toBe(true);
    expect(state.decrypt).toHaveBeenCalledWith({
      key: "test-secret-config",
      data: "sealed-secret",
    });
    expect(state.generate).toHaveBeenCalledWith({ body: { secret: "otp-secret" } });
    expect(
      await verifyRunnerLimitStepUp(
        { method: "totp", code: "123457" },
        { totpSecret: "sealed-secret" },
      ),
    ).toBe(false);
    expect(await verifyRunnerLimitStepUp({ method: "totp", code: "123456" }, {})).toBe(false);
  });
  it("handles RFC 6238 imported ASCII and binary base32 keys without UTF-8 loss", async () => {
    vi.useFakeTimers({ now: 59_000 });
    state.decrypt.mockResolvedValue("base32:GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(
      await verifyRunnerLimitStepUp(
        { method: "totp", code: "287082" },
        { totpSecret: "sealed-secret" },
      ),
    ).toBe(true);
    state.decrypt.mockResolvedValue("base32:QCAYFA4EQWDIPCEJRKFYZDMOR6IJDEUT");
    expect(
      await verifyRunnerLimitStepUp(
        { method: "totp", code: "537124" },
        { totpSecret: "sealed-secret" },
      ),
    ).toBe(true);
    expect(state.generate).not.toHaveBeenCalled();
    state.decrypt.mockResolvedValue("base32:Q");
    expect(
      await verifyRunnerLimitStepUp(
        { method: "totp", code: "537124" },
        { totpSecret: "sealed-secret" },
      ),
    ).toBe(false);
  });
  it("refuses corrupt secrets and verifier failures without passing raw errors to callers", async () => {
    state.decrypt.mockRejectedValue(new Error("sensitive storage contents"));
    expect(
      await verifyRunnerLimitStepUp(
        { method: "totp", code: "123456" },
        { totpSecret: "sealed-secret" },
      ),
    ).toBe(false);
    state.verifyPassword.mockRejectedValue(new Error("password detail"));
    expect(
      await verifyRunnerLimitStepUp(
        { method: "password", password: "typed-password" },
        { password: "hash" },
      ),
    ).toBe(false);
  });
  it("accepts exactly one bounded credential method", () => {
    expect(
      runnerStepUpSchema.safeParse({ method: "password", password: "x", code: "123456" }).success,
    ).toBe(false);
    expect(runnerStepUpSchema.safeParse({ method: "totp", code: "12345" }).success).toBe(false);
    expect(
      runnerStepUpSchema.safeParse({ method: "password", password: "x".repeat(1025) }).success,
    ).toBe(false);
  });
});
