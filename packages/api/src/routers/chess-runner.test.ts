import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

const { authority, budget, budgetOptions, create, start, stop, status } = vi.hoisted(() => ({
  authority: vi.fn(),
  budget: vi.fn(),
  budgetOptions: [] as Record<string, unknown>[],
  create: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@cockpit-chess/db", () => ({ default: {} }));
vi.mock("../lib/two-factor-policy", () => ({
  isTwoFactorPolicySatisfied: authority,
  invalidateForceTwoFactorSettingsCache: vi.fn(),
  isForcedTwoFactorEnabledForRole: vi.fn(),
}));
vi.mock("../lib/procedure-budget", () => ({
  createProcedureBudget: (options: Record<string, unknown>) => {
    budgetOptions.push(options);
    return budget;
  },
}));
vi.mock("../lib/chess-runner", async () => {
  const { z } = await import("zod");
  const slug = z.strictObject({ slug: z.string() });
  return {
    createRunnerInput: z.strictObject({
      machineId: z.string(),
      creationKey: z.uuid(),
      config: z.strictObject({}),
    }),
    runnerSlugInput: slug,
    runnerCommandInput: slug.extend({ commandId: z.uuid(), expectedRevision: z.number().int() }),
    createRunnerMatch: create,
    startRunnerMatch: start,
    stopRunnerMatch: stop,
    runnerMatchStatus: status,
  };
});
const { chessRunnerRouter } = await import("./chess-runner");
function context(user = true, banned = false): Context {
  return {
    session: user ? { user: { id: "owner", banned }, session: { id: "session" } } : null,
  } as Context;
}
const command = { slug: "runner-match", commandId: randomUUID(), expectedRevision: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  authority.mockResolvedValue(true);
  budget.mockResolvedValue(undefined);
});
describe("runner cookie procedure gates", () => {
  it("retains a distinct fail-closed procedure action budget", () => {
    expect(budgetOptions).toEqual([
      expect.objectContaining({ keyPrefix: "chess:runner-control", points: 120, failClosed: true }),
    ]);
  });
  it("refuses anonymous callers on every control and private status", async () => {
    const client = createRouterClient(chessRunnerRouter, { context: context(false) });
    await expect(
      client.createRunner({ machineId: "machine", creationKey: randomUUID(), config: {} }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.startRunner(command)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.stopRunner(command)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.runnerStatus({ slug: "runner-match" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(create).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
  it("refuses active bans before helper dispatch", async () => {
    const client = createRouterClient(chessRunnerRouter, { context: context(true, true) });
    await expect(client.stopRunner(command)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(stop).not.toHaveBeenCalled();
  });
  it("preserves forced second-factor policy before helper dispatch", async () => {
    authority.mockResolvedValue(false);
    const client = createRouterClient(chessRunnerRouter, { context: context() });
    await expect(
      client.createRunner({ machineId: "machine", creationKey: randomUUID(), config: {} }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(create).not.toHaveBeenCalled();
  });
  it("spends the control budget before invoking durable owner-scoped writes", async () => {
    const ctx = context();
    const client = createRouterClient(chessRunnerRouter, { context: ctx });
    await client.stopRunner(command);
    expect(budget).toHaveBeenCalledWith("owner");
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ session: ctx.session }), command);
  });
  it("does not write when the action budget is unavailable", async () => {
    budget.mockRejectedValue(new Error("unavailable"));
    const client = createRouterClient(chessRunnerRouter, { context: context() });
    await expect(client.stopRunner(command)).rejects.toThrow();
    expect(stop).not.toHaveBeenCalled();
  });
});
