import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const env = vi.hoisted(() => ({}) as { SETUP_KEY?: string; FORCE_SSO?: boolean });
vi.mock("@cockpit-chess/env/server", () => ({
  env,
  ADMIN_EMAILS: new Set<string>(),
  get FORCE_SSO() {
    return env.FORCE_SSO === true;
  },
}));
const claimFirstAdmin = vi.hoisted(() => vi.fn());
vi.mock("../lib/admin-bootstrap", () => ({ claimFirstAdmin }));
const consumeBudget = vi.hoisted(() => vi.fn());
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => consumeBudget }));

const { setupRouter } = await import("./setup");

const anonymous: Context = { session: null, clientIp: "203.0.113.9" };
const client = createRouterClient(setupRouter, { context: anonymous });
const input = { token: "tok", newPassword: "a-long-new-password" };

function code(error: unknown): string | undefined {
  return error instanceof ORPCError ? error.code : undefined;
}

let auditLines: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  env.SETUP_KEY = "k".repeat(32);
  env.FORCE_SSO = false;
  consumeBudget.mockResolvedValue(undefined);
  auditLines = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    auditLines.push(String(line));
  });
});

function audits() {
  return auditLines.map((line) => JSON.parse(line.replace(/^\[audit\] /, "")));
}

describe("setup.claimFirstAdmin", () => {
  it("does not exist while SETUP_KEY is unset, so removing the key kills unspent links", async () => {
    delete env.SETUP_KEY;
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    expect(claimFirstAdmin).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
  });

  it("is a 404 before any input validation while SETUP_KEY is unset", async () => {
    delete env.SETUP_KEY;
    const malformed = { token: 42 } as unknown as typeof input;
    await expect(client.claimFirstAdmin(malformed)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    expect(auditLines).toEqual([]);
  });

  it("charges and audits a malformed call before rejecting it", async () => {
    for (const malformed of [{ token: 42 }, { token: "", newPassword: "x" }, null]) {
      await expect(client.claimFirstAdmin(malformed as unknown as typeof input)).rejects.toSatisfy(
        (error) => code(error) === "BAD_REQUEST",
      );
    }
    expect(consumeBudget).toHaveBeenCalledTimes(3);
    expect(claimFirstAdmin).not.toHaveBeenCalled();
    expect(audits()).toEqual(
      Array(3).fill({
        event: "setup.first_admin_claim",
        outcome: "invalid_request",
        ip: "203.0.113.9",
      }),
    );
  });

  it("works anonymously: the link's token is the credential", async () => {
    claimFirstAdmin.mockResolvedValue({ kind: "claimed", userId: "u1" });
    expect(await client.claimFirstAdmin(input)).toEqual({ success: true });
    expect(claimFirstAdmin).toHaveBeenCalledWith(input);
    expect(audits()).toEqual([
      { event: "setup.first_admin_claim", outcome: "claimed", ip: "203.0.113.9", userId: "u1" },
    ]);
    // Never the token or the password.
    expect(auditLines.join(" ")).not.toContain("tok");
    expect(auditLines.join(" ")).not.toContain("a-long-new-password");
  });

  it("refuses under FORCE_SSO, leaving the link unspent, and audits it", async () => {
    env.FORCE_SSO = true;
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "CONFLICT",
    );
    expect(claimFirstAdmin).not.toHaveBeenCalled();
    expect(audits()).toEqual([
      { event: "setup.first_admin_claim", outcome: "password_signin_disabled", ip: "203.0.113.9" },
    ]);
  });

  it("answers SETUP_LINK_INVALID for a dead link", async () => {
    claimFirstAdmin.mockResolvedValue({ kind: "invalid_token" });
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "SETUP_LINK_INVALID",
    );
    expect(audits()[0]).toMatchObject({ outcome: "invalid_token" });
  });

  it("answers BAD_REQUEST for a password outside the policy", async () => {
    claimFirstAdmin.mockResolvedValue({ kind: "password_too_short" });
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "BAD_REQUEST",
    );
  });

  it("charges the per-IP budget before the lookup and hash, and audits a refusal", async () => {
    consumeBudget.mockRejectedValue(new ORPCError("TOO_MANY_REQUESTS"));
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "TOO_MANY_REQUESTS",
    );
    expect(consumeBudget).toHaveBeenCalledWith("203.0.113.9");
    expect(claimFirstAdmin).not.toHaveBeenCalled();
    expect(audits()).toEqual([
      { event: "setup.first_admin_claim", outcome: "rate_limited", ip: "203.0.113.9" },
    ]);
  });

  it("audits an internal failure", async () => {
    claimFirstAdmin.mockRejectedValue(new Error("db down"));
    await expect(client.claimFirstAdmin(input)).rejects.toThrow();
    expect(audits()[0]).toMatchObject({ outcome: "error" });
  });
});
