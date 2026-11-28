/** Real Better Auth + PostgreSQL; invoked only by the owned disposable runner. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

export async function impersonationCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "impersonation");
  const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
  const apiRequire = createRequire(new URL("../../packages/api/package.json", import.meta.url));
  const [{ Hono }, { createRouterClient }, { auth }, { default: prisma }, gate, fence, api] =
    await Promise.all([
      import(serverRequire.resolve("hono")),
      import(apiRequire.resolve("@orpc/server")),
      import("../../packages/auth/src/index.ts"),
      import("../../packages/db/src/index.ts"),
      import("../../apps/server/src/better-auth-admin-gate.ts"),
      import("../../packages/auth/src/password-sign-in-fence.ts"),
      import("../../packages/api/src/routers/users.ts"),
    ]);
  const app = new Hono();
  app.use("/api/auth/admin/*", gate.betterAuthAdminGate);
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.delete("authorization");
    const request = new Request(c.req.raw, { headers });
    return c.req.path === "/api/auth/sign-in/email"
      ? fence.withPasswordSignInFence(request, () => auth.handler(request))
      : auth.handler(request);
  });
  const origin = process.env.BETTER_AUTH_URL;
  const users = [];
  const password = `Disposable-impersonation-${randomUUID()}`;
  const passwordHash = await (await auth.$context).password.hash(password);
  const fixture = async (role = "user") => {
    const id = `impersonation-${randomUUID()}`;
    users.push(id);
    return prisma.user.create({
      data: {
        id,
        name: "Impersonation fixture",
        email: `${id}@example.test`,
        emailVerified: true,
        role,
        accounts: {
          create: { accountId: id, providerId: "credential", password: passwordHash },
        },
      },
    });
  };
  const request = (path, jar, body = {}, extraHeaders = {}) =>
    app.request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  const apply = (jar, response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /max-age=0(?:;|$)/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
  };
  const session = (jar) =>
    auth.api.getSession({
      headers: new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }),
    });
  const begin = async (existing) => {
    const actor = existing?.actor ?? (await fixture("admin"));
    const target = existing?.target ?? (await fixture());
    const jar = new Map();
    // Genuine primary sign-in during the existing enrollment grace. Enroll the
    // fixture before management access; no policy defaults or hooks are changed.
    const signin = await request("/sign-in/email", jar, { email: actor.email, password });
    assert.equal(signin.status, 200);
    apply(jar, signin);
    await prisma.user.update({ where: { id: actor.id }, data: { twoFactorEnabled: true } });
    const original = await session(jar);
    assert.equal(original.user.role, "admin");
    assert.ok(original.session.authenticatedAt);
    const response = await request("/admin/impersonate-user", jar, { userId: target.id });
    assert.equal(response.status, 200, "real Better Auth impersonation succeeds");
    apply(jar, response);
    const impersonated = await session(jar);
    assert.equal(impersonated.user.id, target.id);
    assert.equal(impersonated.session.impersonatedBy, actor.id);
    assert.equal(impersonated.session.authenticatedAt, null);
    return { actor, target, original, impersonated, jar };
  };
  try {
    for (const state of ["active", "banned", "deletion-pending"]) {
      const flow = await begin();
      assert.equal((await request("/admin/list-users", flow.jar)).status, 403);
      const client = createRouterClient(api.usersRouter, {
        context: { session: flow.impersonated },
      });
      await assert.rejects(client.list({ limit: 1 }), (error) => error.code === "NOT_FOUND");
      if (state !== "active") {
        // Defense in depth when a status changes while a target row survives.
        // Normal archival/deletion also revokes sessions; no revoked row may
        // become live just to facilitate returning from impersonation.
        await prisma.user.update({
          where: { id: flow.target.id },
          data:
            state === "banned"
              ? { banned: true }
              : { deletionRequestedAt: new Date(), deletionState: "pending" },
        });
      }
      const cookieBefore = new Map(flow.jar);
      const csrf = await request(
        "/admin/stop-impersonating",
        flow.jar,
        {},
        {
          origin: "https://untrusted.example.test",
        },
      );
      assert.equal(csrf.status, 403, "Better Auth rejects foreign-origin restoration");
      assert.equal(csrf.headers.getSetCookie().length, 0);
      assert.deepEqual(flow.jar, cookieBefore);
      assert.ok(await prisma.session.findUnique({ where: { id: flow.impersonated.session.id } }));
      const response = await request(
        "/admin/stop-impersonating",
        flow.jar,
        {},
        {
          "x-expected-user": flow.target.id,
        },
      );
      assert.equal(response.status, 200, `return from ${state} target succeeds`);
      apply(flow.jar, response);
      const restored = await session(flow.jar);
      assert.equal(restored.user.id, flow.actor.id);
      assert.equal(restored.user.role, "admin");
      assert.equal(restored.session.id, flow.original.session.id);
      assert.equal(restored.session.impersonatedBy, null);
      assert.equal(
        +new Date(restored.session.authenticatedAt),
        +new Date(flow.original.session.authenticatedAt),
      );
      assert.equal(
        await prisma.session.findUnique({ where: { id: flow.impersonated.session.id } }),
        null,
      );
      assert.equal(
        [...flow.jar.keys()].some((key) => key.endsWith(".admin_session")),
        false,
      );
      const restoredClient = createRouterClient(api.usersRouter, {
        context: { session: restored },
      });
      assert.ok(await restoredClient.list({ limit: 1 }));
    }
    for (const state of [
      "revoked",
      "expired",
      "device-session",
      "nested-impersonation",
      "demoted",
      "banned",
      "deletion-pending",
      "unverified",
      "needs-2fa",
    ]) {
      const flow = await begin();
      if (state === "revoked")
        await prisma.session.delete({ where: { id: flow.original.session.id } });
      else if (state === "expired")
        await prisma.session.update({
          where: { id: flow.original.session.id },
          data: { expiresAt: new Date(0) },
        });
      else if (state === "device-session" || state === "nested-impersonation")
        await prisma.session.update({
          where: { id: flow.original.session.id },
          data:
            state === "device-session"
              ? { origin: "device-flow" }
              : { impersonatedBy: flow.target.id },
        });
      else
        await prisma.user.update({
          where: { id: flow.actor.id },
          data:
            state === "demoted"
              ? { role: "user" }
              : state === "banned"
                ? { banned: true }
                : state === "deletion-pending"
                  ? { deletionRequestedAt: new Date(), deletionState: "pending" }
                  : state === "unverified"
                    ? { emailVerified: false }
                    : { twoFactorEnabled: false, createdAt: new Date("2025-01-01") },
        });
      const response = await request("/admin/stop-impersonating", flow.jar);
      assert.ok([401, 403].includes(response.status), `refuse ${state} actor`);
      assert.equal(response.headers.getSetCookie().length, 0);
      assert.equal((await session(flow.jar)).user.id, flow.target.id);
    }
    for (const state of [
      "missing-cookie",
      "tampered-cookie",
      "unrelated-cookie",
      "no-target-session",
    ]) {
      const flow = await begin();
      const name = [...flow.jar.keys()].find((key) => key.endsWith(".admin_session"));
      assert.ok(name);
      if (state === "missing-cookie") flow.jar.delete(name);
      else if (state === "tampered-cookie") flow.jar.set(name, `${flow.jar.get(name)}tampered`);
      else if (state === "unrelated-cookie") {
        const other = await begin();
        flow.jar.set(name, other.jar.get(name));
      } else await prisma.session.delete({ where: { id: flow.impersonated.session.id } });
      const response = await request("/admin/stop-impersonating", flow.jar);
      assert.equal(response.status, 401, `refuse ${state}`);
      assert.equal(response.headers.getSetCookie().length, 0);
    }
    // Two legitimately signed saved cookies for the same actor. The malformed
    // first value used to be discarded by Hono, while Better Call stripped the
    // opening quote and last character and restored the expired saved session.
    const expired = await begin();
    await prisma.session.update({
      where: { id: expired.original.session.id },
      data: { expiresAt: new Date(0) },
    });
    await prisma.user.update({
      where: { id: expired.actor.id },
      data: { twoFactorEnabled: false },
    });
    const live = await begin(expired);
    const savedName = [...live.jar.keys()].find((key) => key.endsWith(".admin_session"));
    assert.ok(savedName);
    const otherCookies = [...live.jar]
      .filter(([key]) => key !== savedName)
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
    for (const prefix of [
      `${savedName}="${expired.jar.get(savedName)}X`,
      `${savedName}=${expired.jar.get(savedName)}`,
    ]) {
      const response = await request(
        "/admin/stop-impersonating",
        live.jar,
        {},
        {
          cookie: `${prefix}; ${savedName}=${live.jar.get(savedName)}; ${otherCookies}`,
        },
      );
      assert.equal(response.status, 401, "ambiguous saved cookies cannot restore an expired actor");
      assert.equal(response.headers.getSetCookie().length, 0);
      assert.ok(await prisma.session.findUnique({ where: { id: live.impersonated.session.id } }));
    }
    console.log(
      "impersonation: real Better Auth restore, admin denial, target lifecycle, actor revocation/policy, cookie binding and CSRF passed.",
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}
