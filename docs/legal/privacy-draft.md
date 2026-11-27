# Cockpit Chess Privacy Notice — en-US draft

> **INTERNAL DRAFT — NOT EFFECTIVE OR APPROVED FOR PUBLICATION.** Prepared 2026-11-27 for owner/counsel review alongside the [Terms draft](./terms-draft.md). Public routes, translations and footer/signup links are deferred to D1 wave 11.
>
> **Dependency markers apply to the entire paragraph, list or table row they introduce.** `PENDING <lane>` means intended behavior awaiting accepted implementation and deployment verification. `OWNER/COUNSEL` marks outstanding identity, legal review or expressly unresolved policy. Owner decisions through 2026-11-27 20:25Z are incorporated; implementation remains pending. Do not remove markers or publish placeholders before approval. This document makes no statutory-compliance claim and is not legal advice.

## 1. Who operates the service and who may use it

**Operator details and OWNER/COUNSEL launch blockers:**

- Operator/controller: **FlyCockpit, LLC**, operating from the **USA** (owner-confirmed).
- Service address: **[OWNER/COUNSEL: address]**.
- Privacy/deletion contact: **[OWNER/COUNSEL: monitored privacy address and request process]**.
- Support and abuse contacts: **[OWNER/COUNSEL: monitored addresses, including a path without an account]**.
- Minimum age: **16** (owner decision). **[OWNER/COUNSEL: validate audience/eligibility wording and handling of underage accounts]**.
- Jurisdiction and intended audience: **[OWNER/COUNSEL: complete and align with Terms]**.
- Effective date/version: **[OWNER/COUNSEL: complete before publication]**.
- EU representative(s): **[PENDING OWNER/COUNSEL: GDPR Article 27 and DSA Article 13 applicability, appointment/designation, name and contact details; no appointment is asserted]**.
- **[OWNER/COUNSEL: validate proposed processing bases below, recipient roles, international transfers/safeguards, individual rights, identity verification, complaint route and response deadlines for the actual audience and deployment.]** Compliance is not asserted by this draft.

**PENDING A3/G1:** This notice is intended for `chess.flycockpit.app`, hosted on the owner's VPS behind Cloudflare. **[OWNER: record actual hosting/relay/backup providers, locations and deployment settings.]** The proxy is not a promise of anonymity: Cloudflare and the service process network metadata. Do not promise that email headers or every origin path conceal the VPS address without A3's direct-edge and delivered-mail audit.

## 2. Information and purposes

Existing hosted processing includes the following. Deployment-specific optional providers must be confirmed before publication; this is not a promise that every account uses every sign-in method.

| Information | Where and why it is processed |
| --- | --- |
| Account/profile name, email, verification, locale, optional image and sign-in-provider identity | Server account records for authentication, profile display, language and account administration. Password authentication stores a password hash; configured external sign-in may also retain provider tokens. |
| Session identifiers, IP address, user agent, expiry, optional 2FA material, verification/reset records and companion credentials | Browser/server authentication, recovery and abuse protection. These are sensitive access records, not public replay fields. |
| Match settings, starting position, moves, requested models/protocols, titles/labels, prompts/context, model replies/remarks/tool results, usage/cost estimates and results | Server database, worker/job processing and transient state to run matches and serve replays/evaluations. Public exposure depends on publication and the future separate official-participation contract below. |
| Hosted OpenRouter connection | The server stores the provider key encrypted for authorized server/worker use, plus safe account/key metadata such as limits, usage and expiry. Website sign-in is separate from this connection. Encryption at rest does not mean the execution system cannot use the key. |
| Operational/network events, rate-limit counters and email delivery metadata | Service security, capacity, delivery and troubleshooting. **OWNER O4; PENDING A3/G1:** confirm exact log fields, redaction, access and expiry; do not log credentials or claim-link secrets. |

**PENDING B1/B2/F1:** Matches also record fixed system-prompt versions/hashes and available resolved provider/model provenance; unavailable identity is marked unknown. A minimal, durable official record retains safe model/protocol identifiers, prompt/settings/starting-position comparison scope, start and outcome/statistics without account IDs, titles or raw replies. This record supports public all-start participation even if the replay is unpublished, hidden or removed after account deletion. It is not a promise that all match text becomes public merely by choosing official.

**PENDING D3/D1 wave 11:** Owner-approved reporting is open to **anyone, signed in or not**, with per-IP limits and deduplication. Reports contain a replay reference, submitted reason, moderation status/audit, and only the contact/account information needed for the approved handling process; visitors without an account do not require an account reference. Administrators investigate reports without disclosing reporter identity to the replay owner; uploader statements of reasons must not leak it. **[OWNER/COUNSEL: finalize required notice information, contact-based reporting, access, retention and review/challenge process.]** Do not promise absolute anonymity from the operator or a response deadline.

**PENDING D1 wave 11/D2a/D2b/D3/G1; OWNER/COUNSEL:** The approved conservative EU approach proposes contract as the processing basis for account/match services and legitimate interests for security logs and abuse limits. Apply data minimization and use only information needed for those purposes. **[OWNER/COUNSEL: validate these bases against actual processing, explain the interests and objection process, and separately assess retained public records/reports after account closure.]** No decision about a person with legal or similarly significant effects is intended to be made solely by automated processing; chess play, rate limits and security checks still use automation. **[OWNER/COUNSEL: verify this statement against actual moderation/enforcement; do not claim the service has no automation.]** These are draft operating constraints, not a GDPR/DSA-compliance certification.

## 3. What is sent to others

- Hosted inference sends the game context needed for a model turn, including configured prompts, board/history and relevant replies/tool context, to OpenRouter and the selected model provider. Provider credentials authenticate those requests. Do not put private personal information or unrelated secrets into game content. Provider handling, billing and retention follow their own terms; **[OWNER/COUNSEL: verify the configured routes and link the applicable provider notices before publication]**. This notice does not promise that providers never retain or train on data.
- **PENDING A3/G1:** Cloudflare handles proxied requests/network metadata; the VPS/hosting provider supports the service infrastructure; the configured mail relay receives destination addresses and verification, recovery or notification message content. Optional backup storage receives the configured backup contents. The planned processor list names **[VPS host]**, **Cloudflare** and **[mail relay]**, plus any chosen backup provider; OpenRouter processing follows the user's own instruction using their own key. **[OWNER/COUNSEL: confirm actual recipients/roles, provider notices, locations and retention, including edge logs/mail headers.]** EU hosting and an EU relay are preferred, not guaranteed before selection. Cloudflare's [privacy policy](https://www.cloudflare.com/privacypolicy/) identifies the EU-US Data Privacy Framework among its transfer mechanisms; **[OWNER/COUNSEL: verify applicable certification, processing scope and transfer safeguards for this deployment before relying on that mechanism]**. EU hosting alone does not establish that all processing stays in the EU.
- Publishing a replay allows other people to view its displayed content, including generated text, and make their own copies. Administrative access for operation/support is distinct from public publication. **OWNER/COUNSEL O4:** approve any additional disclosure circumstances required by the actual legal/operating process; this draft does not invent a data-sale, advertising or legal-disclosure policy.

**PENDING D2a/D2b/D3:** Public reader/export projections must respect publication, administrator hiding and deletion redaction consistently. A hidden transcript is unavailable publicly, including through downloads and image/video exports; hiding does not remove minimal official participation. Hidden published matches remain hidden after deletion.

## 4. Local CLI, runner authorization and spending controls

**PENDING E1/E1L/E2/E3a/E3b/E3S/E4a/E4b/E5/E6:** With the intended `npx @flycockpit/chess` runner, model calls and engine evaluations happen on your machine. Your locally configured provider key, endpoint and hard policy stay there, while the website receives model identifiers/safe capabilities and submitted game moves, evaluations, settings, events and relevant replay data. Local execution is not a promise that the match stays off the server. CLI scores remain untrusted and never official; a locally configured provider may itself be a remote service.

**PENDING E1/E1L/E2:** Each run prints a short-lived single-claim link (proposed unclaimed expiry: about ten minutes). The first eligible signed-in account completing the protected claim owns that run. Keep the link private. Its secret is not a machine bearer; the server retains a digest rather than the reusable claim secret. The terminal shows the claiming account; unauthorized claim-page visitors are not shown that identity. Runner machine authority is stored as a purpose-bound digest server-side and private per-origin CLI state locally, listed/revocable in the account, and checked while connected. Password recovery/reset and account deletion revoke it; ordinary signed-in password change does not itself revoke it.

**PENDING E3a/E3S/E4b:** Operating defaults are $1/match, $10/day and concurrency 2. Browser raises require fresh authentication and remain within locally set authority. Local hard spend defaults are $25/match and $100/day, raised only by a local flag/startup configuration; active ceilings and limit changes appear in the terminal. The local hard concurrency maximum defaults to 8 and is raised only locally. Reconnect grace is 120 seconds while clocks continue, then the match is abandoned; lost liveness pauses new dispatch, and revocation/reset/deletion grants no further dispatch authority. Local spend records, conservative reservations and archives persist on your machine; a restart does not reset the spending ledger.

**PENDING D2b/E1/E2/E4b:** Disconnect/revoke/delete stops future authorized actions but cannot retract a provider request already sent or erase a local key, archive, ledger or another person's download. You control local file removal and provider-side revocation. Deleting the Cockpit Chess account does not delete your OpenRouter or other provider account.

## 5. Cookies and local storage

The current web source has no configured analytics provider. It uses authentication cookies and browser state for preferences and app operation, such as theme, language and PWA caches. This does not mean there are no server/edge logs or authentication metadata.

**PENDING A3/G1/D1 wave 11:** Owner policy is **no tracking analytics of any kind**, strictly necessary cookies only (session, CSRF and locale), **no consent banner**, and **no third-party scripts, fonts or embeds**. Necessary preferences/PWA storage must be inventoried and minimized alongside cookies. **[OWNER/COUNSEL: confirm actual cookie/storage names, purposes and lifetimes, and verify the deployed build and edge behavior before publication.]** This is a launch constraint, not permission to introduce optional analytics later under a generic consent clause.

## 6. Retention and account deletion

**PENDING D2a/D2b/E1/E2/E4b:** The intended settings flow accepts an authenticated, explicitly confirmed deletion request with recent authentication, blocks new account activity and revokes access before cleanup. A pending request is not a completed erasure. Self-delete is not enabled until full cleanup exists. The last administrator must transfer authority first. Cleanup covers sessions, companion/runner credentials, sign-in/recovery/verification/2FA records, the stored OpenRouter connection, queued/running work and transient OAuth/job/cache state; completion must wait until live authority and physical cleanup have been confirmed stopped/completed. Removing our stored key does not revoke it at OpenRouter; revoke it there too.

**PENDING D2a/D2b:** Private matches are deleted. Published matches are retained with attribution **“deleted user”**, including published-but-hidden matches remaining hidden. Retained replays keep legal moves/board, safe model names/catalog IDs, prompt version/settings and numerical results, and drop the user's name, title, comments, raw model replies and tool text. Remove owner/archive identifiers as required by the shared scrubbed projection, assign a neutral new URL and invalidate old identifying links. Minimal official participation survives independently of both account ownership and transcript retention. Renaming an owner alone does not make raw text anonymous: validate replay, download, image and video projections before claiming anonymization.

**OWNER/COUNSEL O4; PENDING D2b/G1 — fill and verify every row before launch:**

| Record class | Proposed retention disclosure requiring approval and deployment evidence |
| --- | --- |
| Active account and private matches | **[OWNER/COUNSEL: normal lifecycle, inactivity policy if any, and completion target for authenticated deletion]**. The deletion policy above requires actual D2b completion, not just request acceptance. |
| Retained published replays and minimal official entries | Published games remain redacted as described above; official participation remains durable. **[OWNER/COUNSEL: validate implemented redaction, duration/review and how privacy requests about identifying content are handled]**. |
| Operational logs | Owner-approved expiry is **30 days**, pending A3/G1 deployment evidence. **[OWNER: confirm fields, redaction, access and automatic expiry, including any retained auth/edge logs]**. |
| Transient job/cache/OAuth state | **[OWNER: actual fields, access, TTLs and confirmed deletion cleanup]**. Operational-log retention does not authorize keeping short-lived credentials/state for 30 days. |
| Reports, support correspondence and moderation audit | **[OWNER/COUNSEL: purpose, access, retention and treatment after reporter/owner deletion]**. Do not silently retain account identifiers indefinitely. |
| Backups, snapshots and manual/pre-restore copies | Owner-approved policy is **encrypted daily backups off the VPS, kept 30 days**, pending D2b/G1 configuration and expiry proof. **[OWNER: confirm destinations, encryption, local/remote expiry and coverage of exceptional snapshots; do not leave indefinite manual copies outside the stated policy]**. |
| Restricted deletion suppression register | Required by owner to prevent restores bringing deleted accounts back. **[OWNER/COUNSEL: minimal identifiers, restricted access and expiry covering the last restorable backup]**. D2b/G1 must reapply suppression before access reopens. |

Current backup tooling is opt-in and defaults off; its local retention varies by backup type, and object-store expiry is separate. It does not establish the proposed public deployment's backup policy. See the [existing backup runbook](../backup-restore.md). Do not equate a local pruning setting with deletion of every backup copy.

**PENDING D2b/G1:** Immutable backups may retain previous data until their approved expiry; this is not immediate erasure from all media. Before restoring service access, the restore process must reapply deletion suppression and retained-replay redaction. User downloads, local runner files and independent provider records are outside account cleanup. **[OWNER/COUNSEL: approve any specific legal retention exceptions and explain their scope; none is invented here.]**

## 7. Choices, requests and publication checklist

**PENDING D1 wave 11/D2a/D2b; account-export implementation assignment pending:** The intended rights process supports access/account data export, rectification, deletion and objection through **[OWNER/COUNSEL: monitored privacy contact and verified request process]**. Account export is added to scope and **planned**, not available merely because this draft mentions it. **[OWNER/COUNSEL: specify secure delivery, proportionate identity checks, applicable limits, response deadlines and the relevant supervisory-authority complaint contact.]** Do not suggest a game archive download is a complete account data export or expose credentials in an export. The [GDPR text](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) is a review reference; legal applicability and final rights wording require validation.

**PENDING D3/D1 wave 11:** The owner-approved public notice-and-action policy accepts reports without requiring sign-in. The single point of contact is **[OWNER/COUNSEL: monitored abuse/authority contact]**; uploader statements of reasons and the terms' moderation explanation are required draft defaults. **[OWNER/COUNSEL: finalize notice handling and review/challenge routes against the actual service and applicable DSA duties.]** The [DSA text](https://eur-lex.europa.eu/eli/reg/2022/2065/oj/eng) is a review reference, not a compliance claim.

You can manage the existing OpenRouter connection in Settings and separately revoke the key at OpenRouter. Avoid publishing identifying content; public viewers may retain copies. **PENDING D2a/D2b/D3/E1/E5:** final settings will expose completed account deletion, runner revocation and approved reporting controls; do not point users to unavailable actions. Use the contact placeholder above only after it is replaced with a monitored channel. **OWNER/COUNSEL O4:** finalize the rights/request process and notices of changes without promising unsupported deadlines or statutory coverage.

**PENDING D1 wave 11 after A3/B/D2a/D2b/D3/E/F1/G1 evidence:** reconcile this notice and the Terms with the final retention/redaction, provider, runner and moderation behavior; obtain owner/counsel approval; then publish localized public pages and links. No public signup launch should rely on these unfinished drafts as an approved notice.

**PENDING cp-privacy-audit/D1 wave 11:** Reconcile the privacy audit's actual code/storage/provider inventory before final delivery. Correct code or text where they differ; approved privacy goals do not establish actual collection, deletion, export, storage expiry or transfer behavior. This internal draft landing does not claim audit completion or launch readiness.
