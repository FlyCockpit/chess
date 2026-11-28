# Cockpit Chess Privacy notice — owner/counsel review draft

> **REVIEW DRAFT — NOT YET EFFECTIVE.** Updated 2026-11-28. Public en-US/es-MX routes carry the same review status. This file records current code behavior and remaining launch approvals; it does not certify legal compliance.

## Contact

**FlyCockpit, LLC**, operating from the United States. Single service/privacy/data-request/abuse/moderation-review contact: **contact@flycockpit.app** (owner 2026-11-28 08:12Z). Launch is not directed at the EU; minimum age 16. Launch account mail is send-only through a relay, not a support inbox.

## Current public review copy

### Who operates the service

FlyCockpit, LLC operates Cockpit Chess from the United States. This launch is not directed at the European Union. The same account access/export, correction, deletion and objection request process is offered to everyone. We use account and game data to provide the service you request, and security data to protect it and handle abuse. Contract and legitimate interests in security and abuse prevention are the proposed bases, subject to owner/counsel review. This notice does not claim statutory compliance or identical legal rights everywhere.

### Information we process

We hold account name, email, locale and sign-in/security records; games, moves, settings, prompts, replies, remarks, tool context and usage/cost records; and safe provider connection and runner metadata. Password authentication stores a protected password representation, not your plaintext password. Connected OpenRouter keys are encrypted at rest but decrypted by our server/worker to make authorized calls. Security processing includes request/network metadata, IP-based rate limits, errors and administrative audit. Some logs and emailed error alerts can contain identifying context. Publication exposes displayed game text; minimal official model/settings/outcome records are public even when the transcript is private.

### Recipients and model requests

Cloudflare handles proxied requests and network metadata. Our VPS host provides compute/storage; a send-only mail relay receives recipient addresses and account-message content, and any configured backup host receives database backups. OpenRouter and its model providers receive the prompts, names, board/history, remarks and context needed for hosted turns, under your connected key. We send OpenRouter’s data_collection: deny setting to restrict provider data collection; prompt caching remains enabled. This is not an independently verified zero-retention or upstream-erasure guarantee. Providers see our egress IP for hosted calls and your machine’s for local calls. A sign-in provider you choose receives its authentication flow. These services may process data outside your country; US operation does not mean all processing stays in the US. Final host/relay/backup identities and locations await deployment verification.

### Local runners and credentials

The paired CLI keeps your configured key, endpoint, spending ledger and hard policy locally. The website receives model capabilities, settings, moves, evaluations, events and replay data, so local execution does not make a game server-free. Each run prints a private single-claim link that expires after ten minutes if unclaimed; the first eligible signed-in claimant owns it. The server stores purpose-bound credential digests, not reusable runner secrets. Review and revoke machines in Settings → Command line. Recovery/admin reset and deletion revoke runner authority; an ordinary signed-in password change does not itself revoke runners. Revocation cannot erase your local files or retract requests already sent.

### Cookies, preferences, offline features and tracking

We configure no visitor analytics, cross-site behavioral tracking or third-party scripts, fonts or embeds. Do Not Track does not change this: tracking remains off. Authentication and requested provider flows use cookies; session cookies normally last 30 days with rolling refresh, and temporary sign-in cookies have shorter purposes/lifetimes. Locale and theme preferences use localStorage, not a locale cookie. Browser storage also supports cross-tab identity, tab recovery/scroll state and the offline/static-cache feature. LocalStorage has no automatic expiry; worker/font caches use lazy 90-day/one-year expiry and static caches update with the app. These feature stores are distinct from necessary authentication cookies. Account deletion does not clear every browser store. Clear this site’s browser data to remove preferences/caches; doing so may sign you out and remove offline availability. With analytics disabled there is no analytics consent banner.

### Retention and backups

Account and private game data remain while you use the account, until deletion cleanup. Redacted published games and minimal official participation are retained without a fixed expiry. Signed-in reporter deletion removes their reports; anonymous reports and minimal moderation history have no automatic expiry in the current implementation. An erased administrator’s audit actor becomes empty. The approved deployment targets are 30-day operational logs and daily encrypted off-VPS backups kept 30 days; these settings and exceptional/manual copies still require deployment verification, so they are not a claim of proven expiry. Short-lived authentication, OAuth and runner state use their own bounded lifetimes. Backups may contain earlier private data until they expire. A restricted restore-suppression register keeps purpose-bound SHA-256 identifiers, request dates and review dates, without names or email addresses, for at least 31 days and longer while any older backup remains restorable, solely to prevent deleted accounts returning. It is not automatically pruned at its review date.

### Account deletion

In Settings → Security, sign in again within five minutes and type DELETE. Existing second-factor requirements apply; administrators transfer authority first. A request first fences access and revokes credentials; worker cleanup waits for live work to stop before erasing the account. Pending means cleanup is not yet confirmed, and failures remain fenced for retry. Cleanup removes private matches, authentication/verification records, stored OpenRouter connection, runner credentials and owned reports. Published matches keep moves/board, safe models, prompt/settings and numbers as “deleted user”; names, titles, comments, raw model/tool text and identifying archive data are scrubbed, neutral links replace old URLs, and hidden matches stay hidden. Minimal official entries survive. Restores reapply suppression before access reopens. This does not erase earlier backups immediately, provider accounts/keys, local runner disks, already-sent mail or viewers’ downloads. Revoke your OpenRouter key there as well.

### Reports and moderation

Anyone may report a published replay with a reason and optional bounded note; no account or contact details are required. Reporting uses per-IP budgets and a purpose-bound daily HMAC deduplication identifier. The report record does not store the raw IP, although network/security systems still process IP addresses. If signed in, the report is linked to your account and is removed on its deletion. Administrators can review notices and record moderation reasons. Replay owners see statements of reasons and recent actions, never reporter identity. Minimal moderation audit may remain with a nullable administrator reference. Do not assume a report note is anonymous to the operator or include sensitive information. Use the contact below for additional notices or review requests.

### Your choices, export and children

Settings → Profile lets you correct your name/locale and export JSON account data or PGN private/published games. Sign in again within five minutes; existing second-factor rules and a separate download budget apply. Files download directly, without an email link. JSON includes safe connection/machine/current-limit metadata, your filed reports and safe statements about your replays; it excludes passwords, tokens, keys, security proofs, IP dedup hashes and other reporters/moderators. Email changes are not currently self-service. Contact us for access, correction, deletion, objection or a problem downloading; we may need to verify identity. Chess, rate limits and security checks are automated; content moderation is administrator-operated, not a promise of no automation. The service is for ages 16 and up. If you believe we hold an underage person’s data, contact us for review and deletion handling.

Send privacy requests, child-data concerns, abuse notices and review requests to the address below. Do not send passwords or provider keys. This dated notice is where revisions will be posted; review its date for changes and contact us about changed practices. External provider notices describe their own processing. Owner approval and deployment verification remain required before launch.

## Approval and deployment checklist

- Owner/counsel approval remains required before effectiveness/launch: age/audience and underage-data handling, lawful bases and privacy-request handling, publication permission, acceptable use, moderation review, legal retention and mandatory rights. No forum, governing-law choice, liability waiver or blanket statutory-compliance claim is invented. Set an effective date only after approval; until then pages say not yet effective.
- G1 must name the actual VPS host, send-only relay and backup provider, their locations/processor notices and applicable transfer safeguards. Cloudflare and OpenRouter are named now; do not infer geography or transfer coverage from the US operator alone. Verify contact delivery/monitoring and delivered account-mail headers; relay configuration alone does not prove origin-IP privacy.
- Owner approved 30-day operational logs and daily encrypted off-VPS backups kept 30 days. Generic backup tooling remains opt-in. G1 must prove automatic expiry of logs, local/remote backups, object versions, manual and pre-restore copies; no current production expiry is asserted here. The current external suppression register is kept at least 31 days and while any older recovery point survives, without automatic pruning at its review date.
- Current anonymous reports and moderation history have no automatic retention expiry. Signed-in reporter deletion cascades their reports; audit actor becomes nullable. Owner/counsel must approve the disclosed purpose and retention or commission a bounded retention change; this lane does not invent or change deletion policy.
- Browser preference/offline feature storage is expressly disclosed separately from necessary authentication cookies. Current localStorage has no automatic TTL and cache expiry is lazy; deletion does not clear every browser store. Confirm the requested-feature/minimization treatment before launch. No analytics or third-party script/font/embed injection is permitted at the edge.
- Revisions are posted in the dated notice. Owner/counsel must approve any additional material-change notice channel/timing before promising it. No automatic notification mechanism or guaranteed response deadline is asserted.
- Run the batched public signed-in/out, en-US/es-MX, desktop/phone, export/deletion/report/runner and anonymous Stockfish-source checks before launch. Code review and mock tests do not prove the deployed operational configuration.

## Implementation evidence

- [Account export](../account-export.md): Settings → Profile, direct JSON/PGN downloads, genuine primary authentication within five minutes, no emailed link, safe owned metadata and explicit exclusions.
- [Account deletion](../account-deletion.md) and [restore suppression](../backup-restore.md#account-erasure-suppression): durable pending fence, positive stop evidence, bounded physical cleanup, redacted retained published replays, independent minimal official entries and external purpose-bound suppression.
- [Access matrix](../access-matrix.md): pre-start official commitment, anonymous notice-and-action, admin reasons, private owner controls, runner authority and export/deletion gates.
- [Stockfish distribution](../stockfish-distribution.md), [application licence](../../LICENSE) and [third-party notices](../../THIRD-PARTY-LICENSES.md): public licences page links `/third-party/stockfish/stockfish-19.0.1-source.tar.gz` and `/third-party/stockfish/Copying.txt`; npm also includes corresponding source.
- Source audit: `packages/agent-runtime/src/adapters.ts`, worker `handlers/chess-run.ts` and CLI `runner-policy.ts` set OpenRouter data collection deny for hosted/remote runner inference while preserving caching. This is distinct from verified upstream zero retention.
- Source audit: `apps/web/src/lib/analytics.ts`, `sw.ts`, `i18n/index.ts` and `packages/auth/src/index.ts` establish current analytics, feature storage and rolling session behavior.

## External provider references

- [OpenRouter privacy](https://openrouter.ai/privacy) and [provider data-policy routing](https://openrouter.ai/docs/guides/routing/provider-selection): upstream policy is separate from this app’s enforcement and account deletion.
- [Cloudflare privacy](https://www.cloudflare.com/privacypolicy/): describes Cloudflare’s processing; actual deployment/transfer applicability still needs review.
