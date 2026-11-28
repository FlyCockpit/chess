# Cockpit Chess Terms of service — owner/counsel review draft

> **REVIEW DRAFT — NOT YET EFFECTIVE.** Updated 2026-11-28. Public en-US/es-MX routes carry the same review status. This file records current code behavior and remaining launch approvals; it does not certify legal compliance.

## Contact

**FlyCockpit, LLC**, operating from the United States. Single service/privacy/data-request/abuse/moderation-review contact: **contact@flycockpit.app** (owner 2026-11-28 08:12Z). Launch is not directed at the EU; minimum age 16. Launch account mail is send-only through a relay, not a support inbox.

## Current public review copy

### Operator and audience

FlyCockpit, LLC operates Cockpit Chess from the United States. The launch is not directed at the European Union. You must be at least 16 to use the service. Protect your account and credentials, and use only keys and runner machines you are authorized to use. Email verification and any required second factor still apply. An age requirement does not mean that the service verifies every visitor’s age.

### What the service does

Cockpit Chess runs and replays chess games involving language models, humans and random baselines. Hosted model calls and Stockfish evaluations run on our server/worker. Paired CLI games run model calls and evaluations on your machine, which sends game data to the website. AI replies can be wrong, offensive or misleading. Settings are configurable; fixed model instructions are recorded with a prompt version and hash. Results are exploratory comparisons, not a controlled benchmark or a guarantee of model quality.

### Provider billing and runner limits

Connecting OpenRouter is separate from signing into this website. Hosted own-key games use your connected key and are billed by OpenRouter under its terms; ordinary users cannot spend the operator’s key. Disconnecting here does not revoke the key at OpenRouter. Local runners use your locally configured provider and key. Runner operating defaults are US$1 per match, US$10 per day and two concurrent games. Browser increases require fresh verification and terminal acknowledgement, within local hard defaults of US$25 per match, US$100 per day and concurrency eight. Only local startup configuration can raise hard ceilings. Stopping cannot retract a request already sent or its charge; check provider billing and limits.

### Official starts and publication

New games default to practice. Eligible hosted games may be committed as official before acceptance; this choice cannot change afterward. Every accepted official start remains in public participation, even if stopped, unpublished, hidden or disconnected, or after account deletion. Points use all starts; withdrawals and stops add no points, and wins/draws/losses, pending games and errors are separate. Minimal public records contain models, prompt/settings, starting-position scope and outcomes, not private transcripts or account identifiers. Humans, local runners and imported games are never official. Local timing, costs and evaluations are unverified; server legality checks do not verify local inference.

### Publishing and responsible use

Games are private by default. Publishing makes displayed game content, including model replies and remarks, public and copyable. Do not include passwords, keys or personal information in game content. Private games still pass through our systems and the providers you use. Do not attack the service, bypass access or spending controls, misuse credentials, or publish unlawful, harassing or privacy-invasive material. You authorize the processing and display needed for your requested games and publication; this does not assert ownership of generated output. Unpublishing cannot retrieve copies others already made.

### Reporting and moderation

Anyone can use Report replay on a published replay, without signing in. Choose a reason and optionally describe the content in up to 1,000 characters; do not include personal contact details or credentials. Reports have per-IP limits and daily deduplication. Administrators review reports and can hide or restore a replay with a recorded reason. The uploader sees the statement and recent decisions on their match and in Studio, including when its archive is unsupported. Reporter identity is never shown to the uploader. Hiding blocks public transcript and export access; republishing cannot override it, and official participation remains counted. Contact us to provide more information or request review; no automatic removal or response deadline is promised.

### Export, deletion and retained games

Settings → Profile offers JSON account data and PGN game downloads after re-sign-in within five minutes. Settings → Security offers account deletion after recent sign-in and typing DELETE; administrators must transfer authority first. Acceptance blocks access and begins cleanup; it is not completed erasure. Private games are deleted. Published games remain as “deleted user”, with moves, board, safe model names, prompt/settings and numerical results; identifying titles, names, comments, raw replies and tool text are removed. They receive neutral URLs and old identifying links stop working. Hidden games stay hidden. Minimal official records persist independently. The privacy notice explains backups and the restricted restore-suppression register. Your local files and provider accounts are outside this cleanup.

Use this single contact for service questions, privacy requests, abuse notices and moderation review. The launch mail relay only sends account messages; reply to the contact address rather than treating those messages as a support channel. Software rights are governed by the linked licences. These draft service terms add no restrictions to Stockfish’s GPL rights. Owner/counsel must approve final legal provisions before launch; this draft chooses no dispute forum, warranty exclusion or waiver of mandatory rights.

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
