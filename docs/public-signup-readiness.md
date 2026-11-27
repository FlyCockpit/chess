# Public signup readiness

Public registration is a deployment choice: explicitly set `SIGNUP_ENABLED=true`
when the public release is ready. Its shipped default remains `false`. The
`ADMIN_EMAILS` marker grants only the existing email/password admin bootstrap;
it is not an allowlist for ordinary public registration. Do not remove it or
replace the auth database creation policy to open registration.

This note covers A1 readiness, not launch approval. Keep
`CHESS_HOSTED_ENABLED=false` and `CHESS_USER_MATCHES_ENABLED=false` until the
public deletion, moderation, legal and hosting gates (D/G in the public launch
plan) and batched release acceptance are complete. Enabling signup alone does
not open hosted inference.

## Activation sequence

1. Prepare the environment-specific SMTP relay and explicit `SMTP_FROM`, exact
   HTTPS public origin, trusted ingress chain and Valkey. Follow
   [deployment](./deployment.md) and [authentication](./auth-and-routing.md).
   Production startup rejects `SIGNUP_ENABLED=true` without `SMTP_HOST`, and
   rejects a relay without a sender. Development only warns about missing
   mail; this does not waive mailbox verification or deliver a working link.
2. Provision the first admin through the existing `SETUP_KEY` flow or
   admin-listed email/password bootstrap. The setup-key claim directly creates
   a verified admin without email; the email/password bootstrap requires the
   mailed verification link. Complete admin 2FA enrollment and remove
   `SETUP_KEY` after setup. Listing an address is
   not proof of mailbox ownership. Public signup must never accept a role or
   verification assertion from its request body. SSO/invite creation retains
   its existing independent policy.
3. On a disposable test deployment, explicitly enable signup with working test
   mail. Walk en-US and es-MX signup, verification, sign-in and Studio at phone
   and desktop widths. A signup success returns no session; an unverified
   account cannot sign in even with its correct password. Existing-address
   success has the same neutral response as a free address. When signup is
   closed, ordinary existing and free addresses get the same rejection; only
   creation of a new, valid bootstrap account is the intended exception.
4. Finish the D/G release gates before enabling both chess flags. Configure the
   shared provider-key sealing secret for the server and worker without
   exposing its value. A verified ordinary user must connect their own
   OpenRouter account before creating a hosted match. Ordinary users cannot
   select operator billing; absence, expiry, revocation or unreadability of
   their own key must not fall back to operator funds. Follow
   [hosted user setup](./deployment.md#hosted-chess-for-users) and the
   [access matrix](./access-matrix.md). Test consent with an owner-authorized,
   credit-limited account during batched e2e; do not automate production signup.

## Existing abuse controls

These are shipped defaults, before the existing rate-limit family overrides.
Keep the current values; do not disable a family or widen a shared IP budget to
hide an unexplained 429.

| Surface | Default budget / key | Store failure |
| --- | --- | --- |
| Signup | 10 attempts/hour per client IP, 15-minute block on exceeding it | Fail closed: 503 with `Retry-After`, no auth handler/mail |
| General auth | 30 requests/minute per client IP on these anonymous routes | Fail closed: 503 with `Retry-After` |
| Signup recipient | 6 attempts/hour per normalized email, separate from recovery | Fail open on store errors; no in-memory insurance |
| Reset/verification recipient | 3 attempts/hour per normalized email, no extra block | Fail open on store errors, behind the fail-closed auth IP guard |
| Hosted create | 12 accepted budget consumptions/hour per user | Fail closed on budget-store errors; no new spending endpoint |
| Own-key admission | One queued/running match per user; 20 starts per rolling 24 hours; global queue cap 200 | Counts and insertion share the existing advisory lock |

The recipient middleware charges requests independently of account existence;
invalid/rejected requests that name a usable email can consume that budget too.
A recipient-only Valkey error deliberately permits delivery while the primary
IP guard still bounds it. A complete outage hits that primary guard first and
blocks signup. Do not describe every mail limiter as fail closed. Test these
two failure modes independently. A signup flood must not spend the separate
password-reset recipient budget.

People behind a shared NAT share the ten-attempt signup allowance. On a 429,
wait for `Retry-After`; preserve recovery access and diagnose which bucket
fired. Do not tune the quota from one office's test alone. Validate trusted
forwarding with the ingress contract before interpreting IP-budget evidence;
client-supplied forwarding headers are not authority. Worker concurrency is
per process; deployment sizing belongs to the hosted admission/hosting lanes.

## Verification evidence

The named readiness tests are `signup-gate.test.ts`, `rate-limit.test.ts` and
`email-recipient-limit.test.ts` in `apps/server/src/`, `index.test.ts` and
`user-creation-policy.test.ts` in `packages/auth/src/`, and
`packages/env/src/server.test.ts`. Existing `packages/api/src/routers/chess.test.ts`
covers verified-user, connection, operator-spend and quota refusals. Forced-2FA
policy tests pin the existing admin default and enrollment grace.

The existing `runtime:test-operations` harness runs reset/sign-in,
verification/activation and device-redemption races on its own disposable
PostgreSQL/Valkey services. Run that harness and the full documented gate on
Boat, never against a real/shared database. Browser and real SMTP/provider
acceptance is a separate batched post-landing check; unit mocks do not prove
message delivery, ingress trust or live account setup.
