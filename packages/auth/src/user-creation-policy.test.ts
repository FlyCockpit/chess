import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";

import {
  getAllowedUserCreationMode,
  getGrantedUserLocale,
  getUserCreationBlockReason,
  markUserCreatedUnderGrant,
  refuseUnprovedUserCreation,
  runWithAllowedUserCreation,
  SIGNUP_DISABLED_MESSAGE,
  wasUserCreatedUnderGrant,
} from "./user-creation-policy";

describe("user creation policy context", () => {
  it("is unset by default", () => {
    expect(getAllowedUserCreationMode()).toBeUndefined();
  });

  it("preserves the creation mode across async work", async () => {
    await runWithAllowedUserCreation("admin-bootstrap", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getAllowedUserCreationMode()).toBe("admin-bootstrap");
    });
    expect(getAllowedUserCreationMode()).toBeUndefined();
  });

  it("records a creation only inside its own grant", async () => {
    markUserCreatedUnderGrant();
    expect(wasUserCreatedUnderGrant()).toBe(false);
    await runWithAllowedUserCreation("admin-bootstrap", async () => {
      expect(wasUserCreatedUnderGrant()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      markUserCreatedUnderGrant();
      expect(wasUserCreatedUnderGrant()).toBe(true);
    });
    await runWithAllowedUserCreation("admin-bootstrap", () => {
      expect(wasUserCreatedUnderGrant()).toBe(false);
    });
    expect(wasUserCreatedUnderGrant()).toBe(false);
  });

  it("isolates overlapping public signup, bootstrap and invite requests, including a failed grant", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bootstrap = runWithAllowedUserCreation("admin-bootstrap", async () => {
      await ready;
      markUserCreatedUnderGrant();
      expect(getAllowedUserCreationMode()).toBe("admin-bootstrap");
      expect(getGrantedUserLocale()).toBeUndefined();
      expect(getUserCreationBlockReason({ signupEnabled: false })).toBeNull();
      throw new Error("failed bootstrap");
    });
    const invite = runWithAllowedUserCreation(
      "admin-invite",
      async () => {
        release();
        await ready;
        expect(getAllowedUserCreationMode()).toBe("admin-invite");
        expect(wasUserCreatedUnderGrant()).toBe(false);
        expect(getGrantedUserLocale()).toBe("es-MX");
      },
      { locale: "es-MX" },
    );
    expect(getUserCreationBlockReason({ signupEnabled: false })).toBe(SIGNUP_DISABLED_MESSAGE);
    expect(getUserCreationBlockReason({ signupEnabled: true })).toBeNull();
    await expect(bootstrap).rejects.toThrow("failed bootstrap");
    await invite;
    expect(getAllowedUserCreationMode()).toBeUndefined();
    expect(wasUserCreatedUnderGrant()).toBe(false);
    expect(getGrantedUserLocale()).toBeUndefined();
  });
});

describe("granted locale", () => {
  it("carries the server-chosen locale only inside its grant", async () => {
    expect(getGrantedUserLocale()).toBeUndefined();
    await runWithAllowedUserCreation(
      "admin-invite",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(getGrantedUserLocale()).toBe("es-MX");
      },
      { locale: "es-MX" },
    );
    await runWithAllowedUserCreation("admin-bootstrap", () => {
      expect(getGrantedUserLocale()).toBeUndefined();
    });
    expect(getGrantedUserLocale()).toBeUndefined();
  });
});

describe("signup-disabled decision", () => {
  it("blocks only when signup is disabled and no creation mode is set", () => {
    expect(getUserCreationBlockReason({ signupEnabled: false })).toBe(SIGNUP_DISABLED_MESSAGE);
    expect(getUserCreationBlockReason({ signupEnabled: true })).toBeNull();
  });

  it("allows every creation mode through when signup is disabled (bootstrap + invite)", () => {
    for (const mode of ["admin-bootstrap", "admin-invite"] as const) {
      runWithAllowedUserCreation(mode, () => {
        expect(getUserCreationBlockReason({ signupEnabled: false })).toBeNull();
      });
    }
  });

  it("keeps the stable message the admin-invite error translation matches on", () => {
    expect(SIGNUP_DISABLED_MESSAGE).toMatch(/sign-?up.*disabled/i);
  });
});

describe("refuseUnprovedUserCreation", () => {
  function refusal(run: () => void): string | undefined {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      return (error as APIError).body?.code;
    }
    return undefined;
  }
  const create = { path: "/admin/create-user" };

  it("lets /admin/create-user run only under the admin-invite grant", () => {
    expect(refusal(() => refuseUnprovedUserCreation({}, create))).toBe(
      "ADMIN_CREATE_USER_UNSUPPORTED",
    );
    runWithAllowedUserCreation("admin-bootstrap", () => {
      expect(refusal(() => refuseUnprovedUserCreation({}, create))).toBe(
        "ADMIN_CREATE_USER_UNSUPPORTED",
      );
    });
    runWithAllowedUserCreation("admin-invite", () => {
      expect(refusal(() => refuseUnprovedUserCreation({ emailVerified: false }, create))).toBe(
        undefined,
      );
    });
  });

  it("creates a verified user only on an IdP sign-in", () => {
    for (const path of ["/sign-up/email", "/admin/create-user", undefined]) {
      runWithAllowedUserCreation("admin-invite", () => {
        expect(refusal(() => refuseUnprovedUserCreation({ emailVerified: true }, { path }))).toBe(
          "EMAIL_VERIFICATION_BY_MAIL_ONLY",
        );
      });
    }
    expect(refusal(() => refuseUnprovedUserCreation({ emailVerified: true }, null))).toBe(
      "EMAIL_VERIFICATION_BY_MAIL_ONLY",
    );
    for (const path of ["/callback/sso", "/sign-in/social"]) {
      expect(refusal(() => refuseUnprovedUserCreation({ emailVerified: true }, { path }))).toBe(
        undefined,
      );
    }
    expect(
      refusal(() =>
        refuseUnprovedUserCreation({ emailVerified: false }, { path: "/sign-up/email" }),
      ),
    ).toBe(undefined);
  });
});
