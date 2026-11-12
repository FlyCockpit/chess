import { DEVICE_FLOW_SESSION_ORIGIN } from "@cockpit-chess/config/cli";
import { describe, expect, it } from "vitest";
import { deviceFlowSessionData } from "./device-session-origin.js";

const session = { userId: "user-1", token: "t" };

describe("deviceFlowSessionData", () => {
  it("tags a session created by the device token endpoint", () => {
    expect(deviceFlowSessionData(session, { path: "/device/token" })).toEqual({
      data: { ...session, origin: DEVICE_FLOW_SESSION_ORIGIN },
    });
  });

  it("leaves every other session at the default origin", () => {
    // Sign-in, social callback, impersonation, and a hook with no endpoint
    // context must never produce a CLI-capable session.
    for (const path of ["/sign-in/email", "/callback/:id", "/admin/impersonate-user", "/device"]) {
      expect(deviceFlowSessionData(session, { path })).toBeUndefined();
    }
    expect(deviceFlowSessionData(session, null)).toBeUndefined();
    expect(deviceFlowSessionData(session, undefined)).toBeUndefined();
  });
});
