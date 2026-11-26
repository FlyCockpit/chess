import type { MockInstance } from "vitest";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@cockpit-chess/db");
const { adminUserExists } = await import("./admin-presence");
const db = prisma as unknown as { $queryRaw: MockInstance };

describe("adminUserExists", () => {
  it("reads the EXISTS flag", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ exists: true }]);
    expect(await adminUserExists()).toBe(true);
    db.$queryRaw.mockResolvedValueOnce([{ exists: false }]);
    expect(await adminUserExists()).toBe(false);
  });

  it("matches the admin token the way isAdminRole does", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ exists: false }]);
    await adminUserExists();
    const strings = db.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray | undefined;
    const sql = strings ? strings.join("?") : "";
    expect(sql).toContain("string_to_array(u.role, ',')");
    expect(sql).toContain("~* '^\\s*admin\\s*$'");
  });
});

describe("adminExistsForAppConfig", () => {
  it("caches only a positive answer, for a minute", async () => {
    const { adminExistsForAppConfig, resetAdminPresenceCache } = await import("./admin-presence");
    resetAdminPresenceCache();
    db.$queryRaw.mockReset();
    db.$queryRaw.mockResolvedValueOnce([{ exists: false }]);
    expect(await adminExistsForAppConfig(0)).toBe(false);
    db.$queryRaw.mockResolvedValueOnce([{ exists: true }]);
    expect(await adminExistsForAppConfig(1_000)).toBe(true);
    // Within the TTL: no query.
    expect(await adminExistsForAppConfig(60_000)).toBe(true);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    // After it: asks again, and sees a demoted last admin.
    db.$queryRaw.mockResolvedValueOnce([{ exists: false }]);
    expect(await adminExistsForAppConfig(61_001)).toBe(false);
    expect(db.$queryRaw).toHaveBeenCalledTimes(3);
  });
});
