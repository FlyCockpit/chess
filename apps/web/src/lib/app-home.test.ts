import { describe, expect, it } from "vitest";

import { APP_HOME, appHomeHref } from "./app-home";

describe("APP_HOME", () => {
  // The arena is the home for everyone; there is no separate dashboard.
  it("is the arena", () => {
    expect(APP_HOME).toBe("/$lang");
    expect(appHomeHref("es-MX")).toBe("/es-MX");
  });
});
