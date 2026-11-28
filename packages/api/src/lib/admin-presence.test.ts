import { DatabaseSync } from "node:sqlite";
import { isAdminRole } from "@cockpit-chess/auth/roles";
import type { Prisma } from "@cockpit-chess/db";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@cockpit-chess/db");
const { adminUserExists, activeAdminUserCount } = await import("./admin-presence");
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

describe("activeAdminUserCount", () => {
  it("counts active admins with the shared token and ban-expiry rules on the supplied transaction", async () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const query = vi.fn().mockResolvedValue([{ count: 2 }]);
    expect(await activeAdminUserCount({ $queryRaw: query }, now)).toBe(2);
    expect(query).toHaveBeenCalledOnce();
    const [strings, instant] = query.mock.calls[0] ?? [];
    const sql = (strings as TemplateStringsArray).join("?");
    expect(sql).toContain("count(*)::int");
    // Authorization requires a verified inbox; pending admin invites cannot save
    // the last usable administrator. Check the predicate on the actual query.
    expect(sql).toContain('AND u."emailVerified" IS TRUE');
    expect(sql).toContain('AND u."deletionRequestedAt" IS NULL');
    expect(sql).toContain("string_to_array(u.role, ',')");
    expect(sql).toContain("~* '^\\s*admin\\s*$'");
    expect(sql).toContain('u.banned IS NOT TRUE OR u."banExpires" <= ?');
    expect(instant).toEqual(now);
  });

  it("executes the verification and ban predicates over verified admins and pending invites", async () => {
    // No external DB: execute the emitted WHERE clause in SQLite memory. Only
    // PostgreSQL's cast, ILIKE and token/array syntax need adapting; verification
    // and ban predicates run verbatim, rather than returning a canned count.
    using sql = new DatabaseSync(":memory:");
    sql.exec(
      'CREATE TABLE "user" (id TEXT, role TEXT, "emailVerified" INTEGER, banned INTEGER, "banExpires" INTEGER, "deletionRequestedAt" INTEGER)',
    );
    sql.function("admin_token", (role) => Number(isAdminRole(role)));
    const insert = sql.prepare('INSERT INTO "user" VALUES (?, ?, ?, ?, ?, NULL)');
    const now = new Date("2026-11-26T12:00:00Z");
    insert.run("a", "admin", 1, 0, null);
    insert.run("b", "user, Admin", 1, 0, null);
    insert.run("invite", "admin", 0, 0, null);
    insert.run("banned", "admin", 1, 1, null);
    insert.run("temporary-ban", "admin", 1, 1, now.getTime() + 60_000);
    insert.run("expired-ban", "admin", 1, 1, now.getTime() - 1);
    insert.run("lookalike", "superadmin", 1, 0, null);
    const query = vi
      .fn()
      .mockImplementation(async (strings: TemplateStringsArray, instant: Date) => {
        const statement = strings
          .join("?")
          .replace("count(*)::int", "count(*)")
          .replace("u.role ILIKE", "u.role LIKE")
          .replace(/AND EXISTS \([\s\S]*?\n {6}\)/, "AND admin_token(u.role)");
        return sql.prepare(statement).all(instant.getTime());
      });
    expect(await activeAdminUserCount({ $queryRaw: query }, now)).toBe(3);
    sql.prepare('UPDATE "user" SET "deletionRequestedAt" = 1 WHERE id = ?').run("a");
    expect(await activeAdminUserCount({ $queryRaw: query }, now)).toBe(2);
    sql.prepare('UPDATE "user" SET "deletionRequestedAt" = NULL WHERE id = ?').run("a");
    sql.prepare('UPDATE "user" SET role = ? WHERE id = ?').run("user", "b");
    sql
      .prepare('UPDATE "user" SET banned = 1, "banExpires" = NULL WHERE id = ?')
      .run("expired-ban");
    expect(await activeAdminUserCount({ $queryRaw: query }, now)).toBe(1);
    // Removing A would leave only the unverified invite; it contributes zero.
    sql.prepare('UPDATE "user" SET role = ? WHERE id = ?').run("user", "a");
    expect(await activeAdminUserCount({ $queryRaw: query }, now)).toBe(0);
  });

  it("returns zero when there are no active admins", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ count: 0 }]);
    expect(await activeAdminUserCount()).toBe(0);
  });
});

describe("admin effect authority", () => {
  const tx = mockDeep<Prisma.TransactionClient>();
  const actor = { kind: "admin", userId: "actor", sessionId: "actor-session" } as const;
  const actorUser = {
    id: "actor",
    role: "admin",
    emailVerified: true,
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
    twoFactorEnabled: true,
    createdAt: new Date(),
  };
  beforeEach(() => {
    vi.mocked(prisma).$transaction.mockImplementation(async (run) => {
      if (typeof run !== "function") throw new Error("Expected transaction");
      return run(tx);
    });
    tx.$executeRaw.mockReset();
    tx.session.findFirst.mockReset();
    tx.user.findUnique.mockReset();
    tx.appSetting.findMany.mockReset();
    tx.$executeRaw.mockResolvedValue(0);
    tx.session.findFirst.mockResolvedValue({ user: actorUser } as never);
    tx.user.findUnique.mockResolvedValue({
      id: "target",
      role: "user",
      emailVerified: true,
    } as never);
    tx.appSetting.findMany.mockResolvedValue([]);
  });
  it("locks current User and Session before validating the actor and applying the effect", async () => {
    const { withAdminRemovalGuard } = await import("./admin-presence");
    const effect = vi.fn(async () => "done");
    expect(await withAdminRemovalGuard("target", effect, actor)).toBe("done");
    const [query, userId, sessionId] = tx.$executeRaw.mock.calls[0] ?? [];
    expect((query as TemplateStringsArray).join("?")).toContain("FOR SHARE OF u, s");
    expect([userId, sessionId]).toEqual(["actor", "actor-session"]);
    expect(tx.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "actor-session", userId: "actor", expiresAt: { gt: expect.any(Date) } },
      }),
    );
    expect(effect).toHaveBeenCalledWith(tx, expect.objectContaining({ id: "target" }));
  });
  it.each([
    null,
    { user: { ...actorUser, role: "user" } },
    { user: { ...actorUser, banned: true } },
    { user: { ...actorUser, emailVerified: false } },
    { user: { ...actorUser, deletionRequestedAt: new Date() } },
  ])("denies revoked actor authority before reading or mutating a target", async (live) => {
    const { withAdminRemovalGuard } = await import("./admin-presence");
    tx.session.findFirst.mockResolvedValue(live as never);
    const effect = vi.fn();
    await expect(withAdminRemovalGuard("target", effect, actor)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(effect).not.toHaveBeenCalled();
    expect(tx.user.findUnique).not.toHaveBeenCalled();
  });
  it("uses the transaction for force2FA and preserves enrolled/grace/overdue behavior", async () => {
    const { withAdminRemovalGuard } = await import("./admin-presence");
    const effect = vi.fn(async () => "done");
    tx.session.findFirst.mockResolvedValue({
      user: { ...actorUser, twoFactorEnabled: false },
    } as never);
    await expect(withAdminRemovalGuard("target", effect, actor)).resolves.toBe("done");
    expect(tx.appSetting.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    tx.session.findFirst.mockResolvedValue({
      user: {
        ...actorUser,
        twoFactorEnabled: false,
        createdAt: new Date(Date.now() - 172_800_000),
      },
    } as never);
    await expect(withAdminRemovalGuard("target", effect, actor)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    tx.session.findFirst.mockResolvedValue({
      user: { ...actorUser, createdAt: new Date(Date.now() - 172_800_000) },
    } as never);
    await expect(withAdminRemovalGuard("target", effect, actor)).resolves.toBe("done");
  });
  it("fails closed if the same-transaction policy read fails", async () => {
    const { withAdminRemovalGuard } = await import("./admin-presence");
    tx.session.findFirst.mockResolvedValue({
      user: { ...actorUser, twoFactorEnabled: false },
    } as never);
    tx.appSetting.findMany.mockRejectedValue(new Error("fixture policy unavailable"));
    const effect = vi.fn();
    await expect(withAdminRemovalGuard("target", effect, actor)).rejects.toThrow(
      "fixture policy unavailable",
    );
    expect(effect).not.toHaveBeenCalled();
  });
});
