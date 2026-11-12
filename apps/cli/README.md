# cockpit-chess — companion CLI

Run the local chess companion with a compiled binary (browser assets are embedded):

```sh
cockpit-chess serve
```

Or run from the repository:

```sh
pnpm --filter web build:local
pnpm --filter @cockpit-chess/cli dev serve
pnpm --filter @cockpit-chess/cli dev run --config match.json --games 2 --swap-colors --json
pnpm --filter @cockpit-chess/cli dev replay ./games/<id>.json
pnpm --filter @cockpit-chess/cli dev --server https://your-app.example.com upload ./games/<id>.json
```

`serve` prints a loopback browser URL. Local games need no account, Postgres or
Redis. Configure inference credentials only in the local terminal. Upload needs
an administrator device-flow login and creates a private draft. See the root
[README](../../README.md) for configurations, prices and protocol options.
The browser companion works with both compiled binaries and source builds;
terminal replay is available, but interactive terminal play is not implemented.

### Inference keys

Each provider key is sent only to its own vendor's host, chosen from the
`--base-url` host (default `https://openrouter.ai/api/v1`):

| Endpoint host | Key read from the environment |
|---|---|
| `openrouter.ai` | `OPENROUTER_API_KEY` |
| `api.openai.com` | `OPENAI_API_KEY` |
| `api.anthropic.com` | `ANTHROPIC_API_KEY` |
| loopback (`localhost`, `127.0.0.1`, `[::1]`) | none, unless `COCKPIT_CHESS_PROVIDER_KEY` is set |
| any other HTTPS host | `COCKPIT_CHESS_PROVIDER_KEY` (required) |

Vendor keys are never sent to another host, including a local server; set
`COCKPIT_CHESS_PROVIDER_KEY` for a gateway, a self-hosted endpoint, or a local
server that needs a key. Direct (non-OpenRouter) remote endpoints also need
`--input-price` and `--output-price`. The OpenRouter model catalog (for prices)
is fetched at most once every ten minutes per process.

`run` resolves credentials before writing any archive. If a game fails, it is
saved as a provider error, the series stops, the completed results are still
printed, and the command exits 1.

Every archive the CLI writes stays within the shared 2 MB interchange limit: a
game that would grow past it ends unscored as `event-limit`, so `replay` and
`upload` always accept it. They reject any file over 2 MB.

### Engine evaluation in compiled binaries

Stockfish runs as a separate process from a file on disk, which a compiled
`cockpit-chess` binary does not contain. The compiled binary therefore rejects
any match whose `rules.engineEvaluation` is not `"off"` (both the `engine_eval`
tool and post-move evaluation) before it starts. Run engine-assisted matches
from source (`pnpm --filter @cockpit-chess/cli dev …`).

The existing binary distribution pipeline is retained but remains unconfigured.
Once releases and the canonical origin are configured, signed-in users can install
from **Settings → Command-line access** using commands of this form:

```sh
curl -fsSL -H "Authorization: Install …" "https://<your-app>/api/cli/install.sh" | sh              # macOS, Linux, WSL
irm -Headers @{ Authorization = "Install …" } "https://<your-app>/api/cli/install.ps1" | iex     # Windows PowerShell
```

## Usage

```sh
cockpit-chess login                     # approve this terminal in your browser
cockpit-chess whoami                    # who am I signed in as (and is an update available)
cockpit-chess update                    # update to the version the app offers
cockpit-chess logout                    # sign out (revokes the session)
cockpit-chess config show               # settings and which servers you are signed in to (never the credentials)
cockpit-chess config set server https://your-app.example.com
cockpit-chess --server https://staging.example.com login   # a second server keeps its own login
```

Logins are stored per server: a credential is only ever sent to the server
that issued it. With no `--server`, `COCKPIT_CHESS_SERVER`, or configured server, the
CLI uses the default built into the binary (normally production).

For CI and scripts, create an API key on the settings page and either pipe it
in once (`cockpit-chess login --with-api-key < key.txt`) or set `COCKPIT_CHESS_API_KEY`.
API keys cannot perform admin actions.

Environment variables: `COCKPIT_CHESS_SERVER` (server origin), `COCKPIT_CHESS_API_KEY`
(credential override, sent to whichever server the command targets — set
`COCKPIT_CHESS_SERVER` next to it in CI), `COCKPIT_CHESS_CONFIG_DIR` (config location),
`COCKPIT_CHESS_INSTALL_DIR` (install scripts' target directory), `COCKPIT_CHESS_DEBUG`
(print stack traces), and for local games `OPENROUTER_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY` and `COCKPIT_CHESS_PROVIDER_KEY` (see
[Inference keys](#inference-keys)).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | error |
| 2 | usage error |
| 3 | not found |
| 4 | not signed in, or the credential was rejected |

## Development

See [AGENTS.md](./AGENTS.md).
