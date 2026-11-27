import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";

import { refuseEmailChange } from "./email-change-policy";

function refusal(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(APIError);
    return (error as APIError).body?.code;
  }
  return undefined;
}

describe("refuseEmailChange", () => {
  it("refuses an email on every Better-Auth user update", () => {
    for (const path of [
      "/admin/update-user",
      "/update-user",
      "/verify-email",
      "/oauth2/callback/sso",
    ])
      expect(refusal(() => refuseEmailChange({ email: "new@example.com" }, { path }))).toBe(
        "EMAIL_CHANGE_UNSUPPORTED",
      );
    expect(refusal(() => refuseEmailChange({ email: "new@example.com" }, null))).toBe(
      "EMAIL_CHANGE_UNSUPPORTED",
    );
  });

  it("refuses an admin-asserted verification", () => {
    for (const emailVerified of [true, false])
      expect(
        refusal(() => refuseEmailChange({ emailVerified }, { path: "/admin/update-user" })),
      ).toBe("EMAIL_VERIFICATION_BY_MAIL_ONLY");
  });

  it("lets the verification routes and every other update through", () => {
    expect(
      refusal(() => refuseEmailChange({ emailVerified: true }, { path: "/verify-email" })),
    ).toBe(undefined);
    expect(refusal(() => refuseEmailChange({ name: "Ada" }, { path: "/admin/update-user" }))).toBe(
      undefined,
    );
    expect(refusal(() => refuseEmailChange({ role: "admin" }, { path: "/admin/set-role" }))).toBe(
      undefined,
    );
  });
});
