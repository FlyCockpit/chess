import { z } from "zod";
import { originUrl } from "../url.js";
import { strictBooleanFlag } from "./shared.js";

// ---------------------------------------------------------------------------
// Server-only variable DECLARATIONS. See ./shared.ts for why these live in a
// side-effect-free module of their own.
//
// Disjointness contract: no key declared here may also appear in ./shared.ts —
// `extends` merges, it does not allow overriding.
// ---------------------------------------------------------------------------

export const serverVars = {
  WORKER_MODE: z.enum(["embedded", "external"]).default("embedded"),
  // Optional process port override. Portless and production platforms inject
  // `PORT`; `SERVER_PORT` is only for raw local runs or container overrides.
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SERVER_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: originUrl("BETTER_AUTH_URL"),
  CORS_ORIGIN: originUrl("CORS_ORIGIN").optional(),
  SSO_ENABLED: strictBooleanFlag(),
  SSO_CLIENT_ID: z.string().optional(),
  SSO_CLIENT_SECRET: z.string().optional(),
  SSO_ISSUER: z.string().optional(),
  SSO_PROVIDER_NAME: z.string().default("SSO"),
  FORCE_SSO: strictBooleanFlag(),
  SIGNUP_ENABLED: strictBooleanFlag(),
  // ---- Companion-CLI downloads (packages/api/src/routers/cli.ts) ----------
  // `owner/repo` whose GitHub Releases carry the CLI binaries. Unset = the
  // install/update endpoints answer 503 and the rest of the app is unaffected.
  CLI_RELEASE_REPO: z
    .string()
    .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "CLI_RELEASE_REPO must be owner/repo")
    .optional(),
  // Read-only token (fine-grained PAT: Contents read on that one repo) for a
  // PRIVATE repo. The server uses it only to ask GitHub for a short-lived
  // signed asset URL; it is never sent to the client.
  CLI_RELEASE_GITHUB_TOKEN: z.string().optional(),
  // Pin the served CLI to one release tag (e.g. v1.4.0) — set it alongside a
  // pinned production deploy so the CLI matches the server. Unset = latest.
  CLI_RELEASE_TAG: z
    .string()
    .regex(/^v\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/, "CLI_RELEASE_TAG must look like v1.2.3")
    .optional(),
  // ---- Rate limiting: three named budgets, two knobs each. -----------------
  // Each budget describes its family's REFERENCE member (the number below);
  // every other limiter in the family keeps its ratio to that reference, so
  // setting a budget re-tunes the whole family coherently:
  //
  //   • POINTS multiplies every family member's points by provided/reference.
  //   • WINDOW_SECONDS multiplies every member's window AND block duration by
  //     the same factor (the window:block ratio is part of each member's
  //     design and moves as a unit).
  //
  // Why not one knob per limiter: a per-surface
  // knob invites squeezing one budget to "be safe" — which locks out a
  // shared office behind one NAT IP — instead of SPLITTING the surface that
  // needs its own bucket. Tighter is not safer; if one surface 429s
  // legitimate users, split the surface instead of shrinking a budget.
  // Burst/sustained ratios, bucket keying, and fail-open/fail-closed stay
  // fixed in code (apps/server/src/rate-limit.ts +
  // packages/api/src/lib/rate-limit-families.ts). Defaults reproduce the
  // shipped numbers exactly.
  //
  // AUTH family — the fail-closed /api/auth/* limiters: general auth surface
  // (this reference, 30/60 s + 5-min block), credential (10/60 s),
  // credential burst (3/10 s), signup (10/h), and 2FA-OTP resend
  // (3/15 min). IP-keyed, so shared-NAT
  // offices share these budgets — size for several concurrent humans.
  RATE_LIMIT_AUTH_POINTS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // RPC family — ordinary request volume: /rpc/* (this reference, 100/60 s),
  // /ready (60), and the SSR catch-all (300).
  RATE_LIMIT_RPC_POINTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_RPC_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // EMAIL family — per-RECIPIENT caps on the anonymous endpoints that mail a
  // caller-supplied address: verification resend / password reset (this
  // reference, 3 per hour), signup (6), and sign-in-triggered mails (10).
  // The 0-second block stays code-fixed: a block on a caller-supplied key is
  // an unauthenticated lockout lever against that user's password reset.
  RATE_LIMIT_EMAIL_POINTS: z.coerce.number().int().min(0).default(3),
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // Exact number of trusted reverse proxies between the client and the app,
  // for deriving the client IP used as the anonymous rate-limit key
  // (apps/server/src/client-ip.ts). 0 (the default) keys on the socket peer
  // and ignores X-Forwarded-For; behind a proxy that shares every client into
  // one bucket. 1 for a single proxy (the generated Dokploy config sets 1 for
  // Traefik); add one per extra proxy whose header the next proxy keeps (2 for
  // Cloudflare -> Traefik only with Traefik trusting Cloudflare's ranges). With
  // N > 0 the app must be reachable only through those proxies.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  ADMIN_EMAILS: z.string().optional(),
  // TTL (seconds) for the in-memory SSR HTML cache of public pages
  // (apps/server/src/ssr-cache.ts). 0 disables the cache entirely; the
  // default keeps a cached public render for up to a minute. Edits to a live
  // URL can take up to this long to appear. See apps/server/src/seo.ts.
  SSR_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(60),
};
