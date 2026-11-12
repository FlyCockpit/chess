import prisma from "@cockpit-chess/db";
import type { RouterClient } from "@orpc/server";
import { authenticatedProcedure, protectedProcedure } from "../index";
import { CliReleaseUnavailableError, getCliRelease } from "../lib/cli-release";
import { chessRouter } from "./chess";

/**
 * The companion CLI's API — served ONLY on `/api/cli/rpc` (bearer credentials:
 * device-flow session tokens and API keys), never on the cookie surface.
 * `apps/cli` imports `CliRouterClient` as a TYPE and gets an end-to-end typed
 * client. See packages/api/src/routers/cli.ts.
 *
 * This router is a published contract. Installed CLIs outlive deploys, so an
 * old binary will call a newer server:
 *
 * - Add procedures and optional input fields freely.
 * - Never rename or remove a procedure, make an input stricter, or drop an
 *   output field that a shipped CLI reads. Add a new procedure instead and
 *   retire the old one only after the oldest supported CLI stops calling it.
 *
 * To expose an existing feature, mount its procedure here rather than copying
 * it, as the chess procedures below do. Admin procedures are
 * reachable with a device-flow session but always reject API keys
 * (`requireAdmin`).
 */
export const cliRouter = {
  chess: {
    importGame: chessRouter.importGame,
    inspect: chessRouter.inspect,
    publish: chessRouter.publish,
  },
  /** Who the CLI is signed in as, and with which kind of credential. */
  whoami: protectedProcedure.handler(({ context }) => {
    const { user } = context.session;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      credential: context.credential ?? "session-token",
    };
  }),

  /**
   * End this CLI's session. A device-flow token is a real session row, so it
   * is deleted server-side. An API key is revoked from the web settings page
   * instead; `cockpit-chess logout` just forgets it locally.
   */
  logout: authenticatedProcedure.handler(async ({ context }) => {
    if (context.credential !== "session-token") return { revoked: false };
    await prisma.session.deleteMany({
      where: { id: context.session.session.id, userId: context.session.user.id },
    });
    return { revoked: true };
  }),

  /** The CLI release this server offers, for `cockpit-chess update` and the update notice. */
  latestRelease: protectedProcedure.handler(async () => {
    try {
      const release = await getCliRelease();
      return { available: true as const, version: release.version, tag: release.tag };
    } catch (error) {
      if (error instanceof CliReleaseUnavailableError) return { available: false as const };
      throw error;
    }
  }),
};

export type CliRouter = typeof cliRouter;
export type CliRouterClient = RouterClient<typeof cliRouter>;
