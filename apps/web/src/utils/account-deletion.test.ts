import { describe, expect, it } from "vitest";
import {
  accountDeletionAcknowledgement,
  accountDeletionIssue,
  hasRecentDeletionProof,
} from "./account-deletion";

describe("account deletion guidance", () => {
  const now = Date.parse("2026-11-28T10:00:00Z");

  it("requires primary proof rather than session creation and rejects future or malformed proof", () => {
    expect(hasRecentDeletionProof(undefined, now)).toBe(false);
    expect(hasRecentDeletionProof(null, now)).toBe(false);
    expect(hasRecentDeletionProof("invalid", now)).toBe(false);
    expect(hasRecentDeletionProof(new Date(Number.NaN), now)).toBe(false);
    expect(hasRecentDeletionProof(new Date(now + 1), now)).toBe(false);
    expect(hasRecentDeletionProof(new Date(now - 300_001), now)).toBe(false);
    expect(hasRecentDeletionProof(new Date(now - 300_000), now)).toBe(true);
    expect(hasRecentDeletionProof(new Date(now).toISOString(), now)).toBe(true);
  });

  it.each([
    [{ data: { reason: "REAUTH_REQUIRED" } }, "reauth"],
    [{ code: "PRECONDITION_FAILED" }, "reauth"],
    [{ status: 412 }, "reauth"],
    [{ data: { reason: "ADMIN_TRANSFER_REQUIRED" } }, "admin"],
    [{ data: { reason: "CLEANUP_UNAVAILABLE" } }, "unavailable"],
    [{ data: { reason: "DELETION_NOT_READY" } }, "notReady"],
    [{ status: 429 }, "rateLimit"],
    [{ code: "TOO_MANY_REQUESTS" }, "rateLimit"],
    [{ message: "sensitive server detail" }, "unknown"],
    [null, "unknown"],
  ])("selects actionable public refusal copy for %j", (error, expected) => {
    expect(accountDeletionIssue(error)).toBe(expected);
  });

  it("limits public acknowledgements to fixed non-capability hints", () => {
    expect(accountDeletionAcknowledgement("pending")).toBe("pending");
    expect(accountDeletionAcknowledgement("unconfirmed")).toBe("unconfirmed");
    for (const value of [undefined, null, "complete", "user-id", { status: "pending" }])
      expect(accountDeletionAcknowledgement(value)).toBeUndefined();
  });
});
