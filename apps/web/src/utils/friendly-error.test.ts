import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({
  default: {
    t: (key: string, params?: Record<string, unknown>) =>
      params && "seconds" in params ? `${key}:${String(params.seconds)}` : key,
  },
}));

const {
  authRequestFailure,
  codeFailureMessage,
  friendly,
  isCodeRejection,
  isCredentialRejection,
  signInFailureMessage,
} = await import("./friendly-error");

afterEach(() => vi.unstubAllGlobals());

const online = () => vi.stubGlobal("navigator", { onLine: true });
const offline = () => vi.stubGlobal("navigator", { onLine: false });

describe("friendly: network failures say what to do", () => {
  it("maps a failed request while offline to the offline copy, over any fallback", () => {
    offline();
    expect(friendly(new TypeError("Failed to fetch"), "Couldn't save.")).toBe("errors:offline");
  });

  it("maps a failed fetch while online to the unreachable copy", () => {
    online();
    expect(friendly(new TypeError("Failed to fetch"))).toBe("errors:unreachable");
  });

  it("keeps mapping server answers by code, offline or not", () => {
    offline();
    expect(friendly({ status: 409, code: "CONFLICT" })).toBe("errors:conflict");
  });

  it("includes the wait time from both retryAfter and oRPC procedure-budget retryAfterSeconds", () => {
    online();
    expect(friendly({ status: 429, code: "TOO_MANY_REQUESTS", data: { retryAfter: 12 } })).toBe(
      "errors:rateLimitedWithSeconds:12",
    );
    expect(
      friendly({ status: 429, code: "TOO_MANY_REQUESTS", data: { retryAfterSeconds: 42 } }),
    ).toBe("errors:rateLimitedWithSeconds:42");
  });
});

describe("isCredentialRejection: only a wrong email or password is the user's input", () => {
  it("is true for Better-Auth's wrong-credentials answer", () => {
    expect(isCredentialRejection({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" })).toBe(true);
  });

  it("is false for server errors, rate limits and network failures", () => {
    expect(isCredentialRejection({ status: 500, code: "INTERNAL_SERVER_ERROR" })).toBe(false);
    expect(isCredentialRejection({ status: 502 })).toBe(false);
    expect(isCredentialRejection({ status: 401, code: "FAILED_TO_CREATE_SESSION" })).toBe(false);
    expect(isCredentialRejection({ status: 401 })).toBe(false);
    expect(isCredentialRejection({ status: 429, code: "TOO_MANY_REQUESTS" })).toBe(false);
    expect(isCredentialRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isCredentialRejection(undefined)).toBe(false);
  });
});

describe("isCodeRejection: only a wrong or expired code is the code's fault", () => {
  it("is true for Better-Auth's code rejections", () => {
    expect(isCodeRejection({ status: 401, code: "INVALID_CODE" })).toBe(true);
    expect(isCodeRejection({ status: 401, code: "INVALID_BACKUP_CODE" })).toBe(true);
    expect(isCodeRejection({ status: 401, code: "OTP_HAS_EXPIRED" })).toBe(true);
  });

  it("is false for rate limits, lockouts, an expired 2FA session and failures", () => {
    expect(isCodeRejection({ status: 429, code: "TOO_MANY_REQUESTS" })).toBe(false);
    expect(isCodeRejection({ status: 403, code: "ACCOUNT_TEMPORARILY_LOCKED" })).toBe(false);
    expect(isCodeRejection({ status: 401, code: "INVALID_TWO_FACTOR_COOKIE" })).toBe(false);
    expect(isCodeRejection({ status: 503 })).toBe(false);
    expect(isCodeRejection(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("authRequestFailure", () => {
  it("is the server's failure for a 401 FAILED_TO_CREATE_SESSION, never 'session ended'", () => {
    online();
    expect(authRequestFailure({ status: 401, code: "FAILED_TO_CREATE_SESSION" })).toBe(
      "errors:serverError",
    );
  });
});

describe("signInFailureMessage: the sign-in form's toast", () => {
  const WRONG = "auth:errors.invalidCredentials";

  it("wrong email or password keeps its specific message", () => {
    online();
    expect(signInFailureMessage({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }, WRONG)).toBe(
      WRONG,
    );
  });

  it("a request aborted offline says you're offline", () => {
    offline();
    expect(signInFailureMessage(new TypeError("Failed to fetch"), WRONG)).toBe("errors:offline");
  });

  it("a request that never reached the server (online) says so", () => {
    online();
    expect(signInFailureMessage(new TypeError("Failed to fetch"), WRONG)).toBe(
      "errors:unreachable",
    );
  });

  it("a 5xx is the shared server-error toast", () => {
    online();
    expect(signInFailureMessage({ status: 503, statusText: "Service Unavailable" }, WRONG)).toBe(
      "errors:serverError",
    );
    expect(signInFailureMessage({ status: 500, code: "INTERNAL_SERVER_ERROR" }, WRONG)).toBe(
      "errors:serverError",
    );
  });

  it("a 401 FAILED_TO_CREATE_SESSION (correct credentials) is a server error", () => {
    online();
    expect(signInFailureMessage({ status: 401, code: "FAILED_TO_CREATE_SESSION" }, WRONG)).toBe(
      "errors:serverError",
    );
  });

  it("a rate limit says to wait", () => {
    online();
    expect(signInFailureMessage({ status: 429 }, WRONG)).toBe("errors:rateLimited");
  });
});

describe("codeFailureMessage: the 2FA verify toast", () => {
  const WRONG = "auth:errors.invalidTotp";

  it("a wrong, backup or expired code keeps its specific message", () => {
    online();
    expect(codeFailureMessage({ status: 401, code: "INVALID_CODE" }, WRONG)).toBe(WRONG);
    expect(codeFailureMessage({ status: 401, code: "INVALID_BACKUP_CODE" }, WRONG)).toBe(WRONG);
    expect(codeFailureMessage({ status: 401, code: "OTP_HAS_EXPIRED" }, WRONG)).toBe(WRONG);
  });

  it("a verify request aborted offline says you're offline, not that the code was wrong", () => {
    offline();
    expect(codeFailureMessage(new TypeError("Failed to fetch"), WRONG)).toBe("errors:offline");
  });

  it("a verify request that never reached the server (online) says so", () => {
    online();
    expect(codeFailureMessage(new TypeError("Load failed"), WRONG)).toBe("errors:unreachable");
  });

  it("a 5xx is the shared server-error toast", () => {
    online();
    expect(codeFailureMessage({ status: 503 }, WRONG)).toBe("errors:serverError");
  });

  it("a 401 FAILED_TO_CREATE_SESSION after a correct code is a server error", () => {
    online();
    expect(codeFailureMessage({ status: 401, code: "FAILED_TO_CREATE_SESSION" }, WRONG)).toBe(
      "errors:serverError",
    );
  });

  it("a rate limit says to wait", () => {
    online();
    expect(codeFailureMessage({ status: 429, code: "TOO_MANY_REQUESTS" }, WRONG)).toBe(
      "errors:rateLimited",
    );
  });
});
