# Chess prompt provenance

The launch has one ruleset, `cockpit-v1`, and one code-shipped prompt bundle, `1`.
There is no prompt editor or registry write API. `chess.info` exposes the safe bundle
manifest, ID and hash; creation accepts its ID or resolves the current ID when omitted.
After launch, instruction changes must add a registry entry rather than edit a pin.

The SHA-256 hashes UTF-8 `JSON.stringify(manifest)` in its recorded key order. The
manifest covers the system reference, turn templates, optional remark instructions,
reply templates, rejection feedback, runtime repeat/cycle guard feedback, engine
feedback and all tool descriptions and
JSON schemas. Settings and board state are dynamic inputs, not alternative prompts.
The exact resolved system text includes immutable rules in the same position as the
[cacheable prefix](./prompt-caching.md). Turn numbers, clocks, remaining budgets,
positions and opponent remarks remain outside that prefix.

Every archive's `config.prompt` is required:

```json
{
  "version": "1",
  "hash": "fdbde19d7cedd632caeaf0204457fc4a6e7fe9cc8eeffc5fd22b909c9950efae",
  "system": "<exact resolved system text, including this match's rules>",
  "promptApplied": true
}
```

`promptApplied` records whether any configured participant uses a model. It is false
for human/random-only games, including no-model fixtures. It does not assert that a
queued match already dispatched an inference. Local, hosted and demo creation all
use this shape. A pin is checked against the registry before dispatch, including
retry and resume. Missing or changed pins and unsupported prerelease rules/archives
are refused; no reader upgrades an old archive or assigns it guessed provenance.

`ChessMatch.promptVersion` and `promptHash` are queryable projections written with
accepted hosted creation and admin import. The version/date/id index supports a
future bounded prompt filter. Existing prelaunch rows stay null, with no backfill.
There is no rules-version database default or enum to change. One forward migration
adds the columns and index; the merged baseline remains unchanged.

Import validates the exact current pin and move sequence, then forces source `local`
and unofficial status. Matching a public hash is evidence of reproducibility, not
proof that a local runner used those instructions. It cannot confer official
standing. Official enrollment policy is separate from this registry.

Each successfully completed model response appends a bounded `reply` event tied to
its reservation's dispatch ID. `resolvedModel` and `resolvedProvider` are the IDs
reported in the actual HTTP response, or explicit nulls when absent. Usage events
carry the same nullable identities when token counts exist. Replies without token
counts still get a reply event; their billing stays unknown. A provider protocol,
requested model, adapter's configured source and model catalog are never substituted
for response-reported identity. Failed/aborted responses do not get a completion
record. Reported identities are provider assertions, not independently verified.

Replay's existing exact-settings copy block includes version/hash/applied status.
JSON preserves the full pin. PGN includes `CockpitVersion`, `CockpitPromptVersion`,
`CockpitPromptHash` and `CockpitPromptApplied` tags. Existing video/share renderers
consume the current archive shape. There is no compatibility rollout or rollback
reader contract for prerelease dumps.
