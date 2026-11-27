# Cockpit Chess Terms of Service — en-US draft

> **INTERNAL DRAFT — NOT EFFECTIVE OR APPROVED FOR PUBLICATION.** Prepared 2026-11-27 for owner/counsel review. This document does not activate features, establish an acceptance mechanism, or replace legal advice. Public pages, translations and links belong to D1 wave 11.
>
> **Dependency markers apply to the entire paragraph, list or table row they introduce.** `PENDING <lane>` means proposed launch wording that must be checked against that lane's accepted implementation. `OWNER/COUNSEL` marks outstanding legal review or expressly unresolved policy. Owner decisions through 2026-11-27 20:35Z are incorporated; implementation remains pending. Remove markers only after evidence and approval; do not publish placeholders. Existing behavior is described separately where it differs from the intended public service.

## 1. Operator, audience and effective date

**Operator details and OWNER/COUNSEL launch blockers:**

- Operator/legal entity: **FlyCockpit, LLC**, operating from the **United States** (owner-confirmed). Launch is not directed at the EU; the same stated privacy choices are offered to everyone.
- Support, privacy/deletion and abuse contact, including for people unable to sign in: see the [single contact slot](./privacy-draft.md#contact).
- Governing law, jurisdiction and dispute process: **[OWNER/COUNSEL: jurisdiction and terms, preserving applicable mandatory rights]**.
- Minimum age: **16** (owner decision). **[OWNER/COUNSEL: validate audience/eligibility wording and handling of underage accounts before launch]**.
- Effective date, revision identifier and notice/acceptance process: **[OWNER/COUNSEL: complete before publication]**.

**PENDING A1/A3/G1:** The intended public service is Cockpit Chess at `chess.flycockpit.app`, operated on the owner's VPS behind Cloudflare. Account creation is subject to deployment enablement, email verification and abuse/capacity controls. Availability of a feature depends on the service's displayed controls; a draft description is not an availability guarantee.

## 2. Service and account use

Cockpit Chess runs and replays chess games involving models and engine assistance. Hosted model calls and hosted engine evaluations run on the server. Connecting OpenRouter authorizes model access; it is separate from signing into Cockpit Chess. Protect your account and provider credentials, use only credentials you are entitled to use, and report suspected compromise to the support contact above. Do not submit secrets or other people's personal information in names, titles or game content.

**PENDING C1a/C1b/C2/E3b/E5/E6:** The public service also supports human-vs-model play and a locally executed CLI runner. CLI model calls and engine evaluations run on your machine, including locally configured model services. The intended npm command is `npx @flycockpit/chess`; publication is performed by the owner. This draft does not assert that the package or runner is available now.

**PENDING B1/B2/F1:** Model system instructions are fixed, versioned and recorded for each match; match settings remain configurable and visible. Results can be compared by prompt version, rules, starting position, settings and billing/opponent cohort. Provider/model identity is reported only where available; unknown provenance stays unknown and older unversioned games are labeled honestly. These are exploratory results, not a claim of an unbiased controlled benchmark or guaranteed model quality. Generated replies and evaluations can be inaccurate or offensive and do not represent the operator's views or a provider's endorsement.

## 3. Your provider charges and service limits

Hosted own-key matches use your connected OpenRouter credits. The server stores an encrypted provider credential for authorized server/worker use. Provider charges and terms are separate from Cockpit Chess; review the provider's pricing, key limits and account controls. Do not treat a displayed estimate as a provider invoice or promise of free inference. Disconnecting in Cockpit Chess removes the stored connection and requests stopping its work; it is not vendor-side revocation. Also revoke the key through OpenRouter, especially if compromise is suspected.

**PENDING A2/C1b:** Hosted admission and concurrency are bounded. A queued request may wait or be refused when capacity or account limits are reached. Human-turn and match clocks follow the displayed rules. Infrastructure/provider failures may interrupt a game; a stop or disconnect cannot recall a request already sent to a provider.

**PENDING E1/E1L/E2/E3a/E3b/E3S/E4a/E4b/E5:** A CLI run prints a single-claim link: the first eligible signed-in account to complete its protected claim controls that run. Keep the link private. The proposed unclaimed-link lifetime is about ten minutes, subject to final implementation. The terminal identifies the claiming account and shows operating-limit changes. The runner accepts defined chess actions, not remote shell commands, arbitrary code or file access. Provider keys, locally chosen provider endpoints and hard policy remain local; the service receives match data, model identifiers and safe capabilities. Machine authorization is separate from a browser session and can be revoked. Password recovery/reset revokes runner authority; an ordinary signed-in password change does not itself revoke the runner.

**PENDING E3a/E3S:** CLI operating defaults are **$1 per match, $10 per day and 2 concurrent matches**. Browser increases require fresh password/2FA authentication and cannot exceed local authority. Local hard spend ceilings default to **$25 per match and $100 per day**; only a local startup flag/configuration can raise them. The terminal prints active ceilings. Local enforcement covers actual requests, retries and fallback reservations across the applicable spending profile; unresolved usage remains conservatively reserved. These controls do not promise a refund or control over a provider's billing system. Use provider-side limits as additional protection.

**PENDING E3a/E3S/E4b:** The local hard concurrency maximum defaults to **8** and can be raised only locally. The reconnect grace is **120 seconds** while match clocks continue; new model dispatch pauses on lost liveness, and grace expiry makes the match abandoned. Credential revocation, reset or deletion does not grant a grace period for further authorized work.

## 4. Official commitment, practice and public results

**PENDING B2/F1:** New matches default to practice. Choose official or practice **before acceptance**. An accepted official entry is a public commitment from the queued start, not only after a favorable result. It cannot be promoted, demoted or removed by the owner after starting. Every accepted start remains counted, including pending, cancelled, withdrawn, abandoned, unscored and failed work. The primary metric uses all starts; withdrawals and stops count as starts with no points. W/D/L, withdrawals and errors are shown separately; provider/infrastructure errors are not invented wins or losses.

**PENDING B2/F1:** Official entry existence, start, safe model/settings/prompt information and outcome remain publicly discoverable independently of the replay transcript. Unpublishing a transcript, moderation or account deletion does not remove official participation. Full transcript publication is a separate choice. Human games, local CLI/runner games and imports are **never official**, even if published; human-vs-model games have a separate “vs humans” list. CLI evaluations are untrusted scores, not verified official evidence; server legality checks do not make local inference trusted.

## 5. Publication, acceptable use and moderation

Publishing a replay makes its displayed game content, including model replies and remarks, accessible to others. Consider whether titles, labels or generated replies identify you or someone else before publishing. Viewers can copy or redistribute what they see; withdrawing access on this service cannot retrieve copies they already made. Private content is still processed by the operator's systems and the providers used for the match; private does not mean exclusively stored on your device.

**OWNER/COUNSEL O4:** Proposed acceptable-use wording: do not misuse accounts or credentials, bypass admission or local-authority controls, attack the service, or publish unlawful, abusive or privacy-invasive material. **[OWNER/COUNSEL: approve content permission needed to operate/display replays, restrictions, enforcement and review/appeal process; do not imply ownership of model output or add software-license restrictions.]**

**PENDING D3/D1 wave 11:** The owner-approved notice-and-action policy lets **anyone, signed in or not**, report a published replay, with per-IP limits and deduplication. **[OWNER/COUNSEL: finalize the report form, required notice information and handling process.]** Administrators can hide/unhide content with a recorded reason/audit, and the uploader receives a statement of reasons. Reporter identity is not disclosed to the replay owner. Hiding removes public transcript/export access but does not erase official participation; owners cannot bypass a hide by republishing. The single contact in the privacy notice also handles abuse notices. **[OWNER/COUNSEL: finalize notice acknowledgement, review/challenge route and contact accessibility before publication.]** Do not promise an immediate response or removal deadline without an approved operating process.

## 6. Account deletion and retention

**PENDING D2a/D2b/E1/E2/E4b:** The intended authenticated deletion flow requires recent authentication and explicit confirmation. It first blocks new activity and revokes account/machine access, then completes cleanup; a pending request is not a completed deletion. Private matches are deleted. Published matches remain with attribution **“deleted user”**, with the approved redaction of identifying material. Published-but-hidden matches remain hidden. Official participation survives independently of whether a transcript was private or published. A sole remaining administrator must transfer authority before self-deletion.

**PENDING D2a/D2b:** Retained published games keep legal moves/board, safe model names/catalog IDs, prompt version, settings and results. They drop the user's name, title, comments, raw model replies and tool text, remove identifying owner/archive IDs, and receive a neutral new URL; old identifying URLs are invalidated rather than redirected. Clearing an account link or replacing the display name alone does not establish anonymity. Final wording must cover replay pages, downloads and image/video exports consistently; counsel must review remaining identification risk.

**PENDING D2b/G1:** Operational logs are kept for **30 days**; encrypted daily backups are stored off the VPS and kept for **30 days**. A restricted deletion-suppression register prevents restoration from resurrecting deleted accounts/content. These are approved deployment targets awaiting implementation evidence, not descriptions of current backup defaults. Deletion does not promise immediate removal from immutable backups or recipients' copies. Restore procedures must reapply deletion suppression before access reopens. Reports and other outstanding retention details are marked in the [privacy draft](./privacy-draft.md). Deleting a Cockpit Chess account does not delete third-party accounts or your local runner files; local provider keys, ledgers and archives remain under your control.

**PENDING D1 wave 11/D2a/D2b (export implementation assignment outstanding):** The same account data access/export, correction, deletion and objection/request choices are planned for everyone, wherever they live. **[OWNER/COUNSEL: finalize the authenticated export and contact request process against implemented behavior; do not advertise an export button before it exists.]** The minimum age is 16; the [privacy draft](./privacy-draft.md) covers children, Do Not Track and policy-change notices. An age statement alone is not a claim of implemented age screening or COPPA compliance.

## 7. Source code and third-party software

Cockpit Chess is licensed under **AGPL-3.0-only**; see [LICENSE](../../LICENSE) and [third-party notices](../../THIRD-PARTY-LICENSES.md). The existing “Source code” footer identifies the running source. Software-license rights remain governed by their licenses; these service terms add no restrictions to using, copying, modifying or redistributing Stockfish under its GPL-3.0 license. “Powered by Stockfish” does not imply endorsement.

**PENDING E6/G1:** Final CLI artifacts that convey Stockfish must include the exact engine's license/copyright notices and access to corresponding source and build information for the distributed build. **[OWNER/COUNSEL: verify artifact contents and durable source location before claiming distribution compliance.]** Do not claim current compiled binaries include a usable engine or promise browser engine delivery: hosted evaluations stay server-side.

## 8. Remaining owner/counsel review

**PENDING D1 wave 11 after cp-privacy-audit and later lanes:** The audit of baseline code confirms no configured visitor analytics, but current deletion/export, log expiry, backup policy and storage minimization do not yet meet the intended launch contract. Reconcile final text with later lanes' accepted behavior and the deployed storage/provider inventory. This internal draft does not claim legal approval or launch acceptance.

**PENDING A3/G1/D1 wave 11:** The approved public-service policy is no tracking analytics, strictly necessary cookies/storage only, no consent banner, and no third-party scripts, fonts or embeds. The current audit finds authentication/provider-flow cookies, header/state CSRF protection and localStorage locale/preferences; do not describe locale or CSRF as separately issued cookies. Preference/offline storage needs an approved necessity/minimization treatment before launch. Actual providers and locations still require confirmation. The privacy draft records proposed processing bases, rights offered to everyone, transfer disclosures and California/children's privacy review items; none establishes statutory compliance.

**OWNER/COUNSEL O4:** **[Approve jurisdiction-appropriate availability, warranty, liability, termination, changes/notice, disputes and mandatory-rights language.]** No exclusion, waiver, indemnity, statutory-compliance assertion or new commercial fee is adopted by this draft. Confirm that the linked privacy notice describes the actual deployment and provider relationships. Owner/counsel approval and evidence from all marked lanes are required before wave 11 public delivery.
