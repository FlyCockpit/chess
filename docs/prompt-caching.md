# Chess prompt caching

The match runner sends a fixed system prefix (`matchSystemPrompt`) containing
the game protocol reference and the match's immutable rules. Position, remaining
tokens, clocks, current evaluation, move list and opponent remark follow in a
user message. System text and tool schemas contain no turn number, timestamp,
request ID or remaining budget. Tools close over the current board, but their
serialized definitions stay the same throughout the match.

Both context modes enable caching. Fresh mode rebuilds only the changing user
turn; persistent mode appends the per-side conversation. Transport IDs and
timestamps are not model message content. Persistent memory trimming can remove
old turns and lose their cache reuse, while the fixed system prefix survives.

## Protocols and routing

| Protocol | Cache boundary | Affinity |
| --- | --- | --- |
| Anthropic Messages | TanStack's system, final tool and latest eligible user breakpoints | `x-session-id` on OpenRouter only |
| OpenAI Chat Completions | Automatic prefix caching | `prompt_cache_key`; OpenRouter also gets `x-session-id` |
| OpenAI Responses | Automatic prefix caching | `prompt_cache_key`; OpenRouter also gets `x-session-id` |
| OpenRouter adapter | Anthropic system/tool breakpoints; Gemini fixed system breakpoint; other models use implicit caching | SDK `sessionId` serializes to `session_id` |
| Gemini via OpenRouter Chat Completions | Explicit fixed system-content breakpoint | Same per-side session as other native protocols |

The stable key is `chess-<match id>-<side>` across turns, tool rounds and retries.
Random loop/thread IDs never replace it. The runtime's `cache:false` diagnostic
option disables its markers and affinity hints; compatible providers can still
perform implicit caching independently.

Gemini's implicit cache was unreliable in the live audit, so Chat Completions
marks the system content explicitly. The dynamic user suffix stays outside that
breakpoint. Gemini Responses retains automatic caching; it does not use this
Chat Completions content rewrite. Only the tested model/protocol combinations
below have live cache-hit evidence.

[OpenRouter's routing documentation](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
describes session hints as best-effort provider affinity. A privacy filter such
as `provider.data_collection: "deny"` narrows eligible routes; it does not override
that filter to preserve a cache. Provider outages, fallback, an explicit provider
order, alias/model changes or cache expiry can still invalidate reuse. Keep any
privacy/routing policy consistent within a match. This change does not set a new
data-collection default or pin a provider outside the operator's routing policy.

## Usage and cost

Usage events preserve optional `cachedInputTokens` and
`cacheCreationInputTokens`. The common archive validator, CLI, worker, API and
web readers all use this schema. Old archives remain readable, with absent cache
usage kept unknown. Upgrade these readers together before emitting new usage
fields; an older strict reader will reject them. The first build containing
these fields is the minimum reader for archives that contain cache counts.

`matchStats` sums reported reads and writes; read share is the sum of reported
reads divided by the sum of reported input, rather than an average of turn
percentages. Studio's existing replay/cost surface shows those values. The
installed SDK drops some explicit zero counts, so the display labels the share
as a lower bound and keeps all-unknown usage unavailable. Missing dispatch usage
is still unknown for cost and reservation purposes.

Anthropic's raw `input_tokens` excludes reads and writes; its adapter adds those
parts exactly once to normalize total input. OpenAI/OpenRouter totals already
include cached input. Gemini can report both a read and a write for the same
prefix in one request: those two fields are not necessarily disjoint.

Existing cost calculations and conservative reservations are unchanged. They
use the quoted input/output rates, so archive cost is not the provider's actual
cache-discount bill. Live measurements use the provider's response `usage.cost`
for billed cost; they never subtract guessed discounts from budget enforcement.

## Regression contract for B1

Version the complete fixed system text, static turn/tool instructions and tool
schemas together. Pin a version for the whole match, including retry and resume.
Do not interpolate timestamps, remaining budgets, clocks, move numbers, current
positions, remarks or random IDs into the cached system prefix. The initial B1
version must preserve the post-cp-cache prefix rather than restoring the former
short paragraph. Keep the runner's consecutive-turn prefix tests for every
protocol and both context modes, and the real-adapter HTTP usage fixtures.

The fixed protocol reference plus rules clears the 1,024-token threshold in the
tests; it is useful game instruction, not repeated padding. Minimums depend on
the model: [OpenAI documents a 1,024-token minimum for recent models](https://developers.openai.com/api/docs/guides/prompt-caching),
and [Anthropic's model-specific minimums](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
range higher or lower. This prefix does not promise cacheability on every model
in the catalog. A model/version change must repeat the bounded live proof.

The 2026-11-27 local audit measured six turns per side with Haiku 5.5 Messages,
GPT-6 Luna Chat Completions and Responses, Gemini 2.5 Flash Chat Completions, and
DeepSeek v4.1 Flash 1017 Chat Completions. Per-request token/write/cost evidence
and unsuccessful probes are retained in the cp-cache orchestrator work report.
Never send real keys or live measurement jobs to remote test sandboxes.
