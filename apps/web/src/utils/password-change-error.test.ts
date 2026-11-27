import enSettings from "@cockpit-chess/locales/src/en-US/settings.json";
import esSettings from "@cockpit-chess/locales/src/es-MX/settings.json";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { resolvePasswordChangeErrorMessage } from "./password-change-error";

const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: {
      "en-US": { settings: enSettings },
      "es-MX": { settings: esSettings },
    },
    defaultNS: "settings",
    react: { useSuspense: false },
  });
});

describe("resolvePasswordChangeErrorMessage", () => {
  it.each([
    ["en-US", enSettings],
    ["es-MX", esSettings],
  ] as const)("maps password write codes and statuses in %s", async (locale, copy) => {
    const t = i18n.getFixedT(locale, "settings") as TFunction<"settings">;
    expect(resolvePasswordChangeErrorMessage({ code: "INVALID_PASSWORD" }, t)).toBe(
      copy.security.currentPasswordMismatch,
    );
    expect(resolvePasswordChangeErrorMessage({ code: "PASSWORD_WRITE_UNCONFIRMED" }, t)).toBe(
      copy.security.passwordWriteUnconfirmed,
    );
    expect(resolvePasswordChangeErrorMessage({ status: 409 }, t)).toBe(
      copy.security.passwordWriteUnconfirmed,
    );
    expect(resolvePasswordChangeErrorMessage({ code: "PASSWORD_WRITE_BUSY" }, t)).toBe(
      copy.security.passwordWriteBusy,
    );
    expect(resolvePasswordChangeErrorMessage({ status: 503 }, t)).toBe(
      copy.security.passwordWriteBusy,
    );
    expect(resolvePasswordChangeErrorMessage({ code: "UNKNOWN" }, t)).toBe(
      copy.security.passwordChangeError,
    );
  });
});
