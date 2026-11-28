# Public Cloudflare origin and mail privacy contract

This is the ingress contract for `chess.flycockpit.app`, hosted on an owner's
VPS behind the Cloudflare HTTP proxy. It is a rollout checklist, not evidence
that DNS, a firewall, a relay or WebSockets have been configured. The owner
applies infrastructure changes; keep actual origin addresses, captures, mail
sources, certificates and credentials in restricted operational records, outside
the checkout. Use placeholders in tickets and public documentation.

Use the existing [deployment guide](./deployment.md) for images, same-origin
authentication, readiness and worker setup, and [backup/restore](./backup-restore.md)
for data operations. This document adds the public ingress/privacy requirements.
The deployment generator's Traefik-only `TRUST_PROXY_HOPS=1` is not proof of the
public proxy chain. The public fixtures below explicitly choose a measured chain;
no generator defaults, schema or API are changed. The existing deployment guide's tunnel instructions describe
a different topology; their “Cloudflare ranges not needed” statement applies
only to that tunnel.

## Choose and verify one ingress path

Recommended path: visitor → Cloudflare edge → restricted HTTPS Traefik → private
app. Cloudflare validates the origin's certificate; Traefik authenticates the
owner's zone and accepts forwarded headers only from verified edge peers.
All HTTP requests, including WebSocket upgrades, must traverse that same path.
Do not expose a shorter path with the same app hop setting.

`apps/server/src/client-ip.ts` is the single application IP trust rule:
`TRUST_PROXY_HOPS=N` selects exactly N entries from the right of
`[...X-Forwarded-For, socketPeer]`. Zero uses the socket. A missing, too-short or
invalid selected entry falls back to the socket, never the leftmost value or
`CF-Connecting-IP`. This fallback is bucket selection, **not ingress denial**.
A direct caller with enough forged entries can choose a key when N is positive;
network isolation and origin authentication must prevent that caller reaching
the app. The resolver does not validate the source against Cloudflare ranges.

Better Auth's independent forwarded-header IP collection is disabled with
`advanced.ipAddress.disableIpTracking=true`. No current product or authorization
decision needs a stored session IP, so new sessions store an empty IP string
instead of using a second forwarding trust rule. Cookie authentication,
user-agent metadata, and the app's canonical-IP rate limits remain in effect.
The existing session-create hook also clears inherited IPs when two-factor or
other session rotations supply a legacy parent row as an override, after the
existing device-origin tagging, credential-lock and parent-session fences.
This does not erase IPs from existing session rows, ingress logs or backups;
their retention/erasure remains part of the account/data operations contract.

Two supported *measured chain shapes*, not interchangeable recipes:

| Ingress behavior at the app boundary | App XFF | App socket | Exact hops |
| --- | --- | --- | --- |
| Edge appends the visitor; trusted Traefik preserves that chain and appends its edge peer | `[untrusted prefix,] visitor, CF-edge` | Traefik | `2` |
| An authenticated ingress deliberately replaces XFF with exactly one validated visitor, **after all append operations** | `visitor` | That ingress | `1` |

The first is the recommended Traefik path. Cloudflare documents appending the
address connecting to its edge to an existing XFF chain. Traefik's
`forwardedHeaders.trustedIPs` controls whose forwarding headers it trusts; its
normal XFF behavior appends the connecting peer. Confirm the pinned version and
actual headers, including any header middleware, instead of inferring the
result from labels. See [Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/#x-forwarded-for)
and [Traefik entrypoints](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/#forwarded-headers).

Never copy `CF-Connecting-IP` into XFF from an arbitrary peer. The HOPS=1 variant
requires a separately verified normalizer: authenticate the edge/zone first,
validate exactly one IP literal, replace the entire incoming XFF, and prove
that no later proxy appends another entry. Stock Traefik header settings with a
static value do not implement this dynamic normalization. There is no second
CF-header mode in the app and no automatic hop detection.

Keep Cloudflare Pseudo IPv4 **Off** for this contract so IPv6 remains native;
disable visitor-IP-removal transforms on this hostname. Do not insert Workers,
another CDN, load balancers or alternate origin routes without revalidating the
chain and spoof tests. Worker subrequests have different client-IP semantics;
they are not an accepted shortcut for this topology. See [Cloudflare IP header
semantics](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)
and [Pseudo IPv4](https://developers.cloudflare.com/network/pseudo-ipv4/).

## Restrict and authenticate the origin

Complete all of these before enabling positive app hop trust on a public VPS:

1. Proxy the public hostname at Cloudflare. Enable **Full (strict)** encryption
   with an unexpired origin certificate for the exact owner hostname, issued by
   a public CA or Cloudflare Origin CA. Never use Flexible, disable certificate
   checks, or allow plain HTTP to the app as an internet fallback. The owner
   chooses Origin CA or DNS-01 certificate issuance so inbound HTTP-01 does not
   require opening a second path. See [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/).
2. Allow inbound origin HTTPS only from the **current full Cloudflare IPv4 and
   IPv6 proxy ranges**. Enforce this at the provider/network firewall and at the
   effective host/container ingress. Deny all other internet sources and unused
   public ports, including alternate HTTP(S) ports; close port 80 and redirect
   visitors to HTTPS at the edge. Validate IPv6 separately even if DNS currently
   has no AAAA record. Disabling public IPv6 is an alternative only when verified
   at the network/listener, not just by removing DNS. Cloudflare's authoritative
   [range inventory](https://www.cloudflare.com/ips/) and [origin guidance](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/)
   are the operator's inputs; example IPs in tests are not an allowlist.
3. Require **zone-specific authenticated origin pulls**, using a custom client
   certificate and an origin verifier that trusts only this deployment's
   dedicated client CA/certificate authority. Do not also trust Cloudflare's
   globally shared AOP CA: global AOP proves Cloudflare network membership, not
   this account/zone. Give no other zone a certificate under that trusted CA.
   An equivalent private authenticated ingress is acceptable only with the same
   other-zone negative probe. Rotate before expiry with a bounded overlap, then
   remove the retired trust and re-test. Keep all keys out of Git, image layers
   and logs. See [AOP configuration levels](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/).
4. Restrict both TLS SNI and HTTP Host to the owner hostname. Use strict SNI,
   certificates for allowed names only, an exact `Host(...)` router and required
   verified client certificates (`RequireAndVerifyClientCert` with the dedicated
   CA). Unknown/missing SNI, unknown Host, and allowed-SNI/wrong-Host combinations
   must not reach chess; reject rather than redirect to a revealing hostname.
   Test the reverse mismatch too. A Host rule alone is not TLS authentication,
   and `sniStrict` alone is not a Host allowlist. See [Traefik TLS options](https://doc.traefik.io/traefik/reference/routing-configuration/http/tls/tls-options/).
5. On the chess entrypoint, set `forwardedHeaders.trustedIPs` to the same current
   Cloudflare ranges and keep `forwardedHeaders.insecure=false`. Preserve the
   verified edge chain and append the actual edge socket peer; do not enable
   `notAppendXForwardedFor` for the HOPS=2 shape where that option exists. Do not
   enable unauthenticated PROXY protocol or trust a broad Docker/LAN subnet as
   an edge substitute. Strip unused alternate visitor-supplied IP headers at
   ingress, or ensure no consumer trusts them: the app ignores `Forwarded`,
   `X-Real-IP`, `True-Client-IP` and `CF-Connecting-IP`. Preserve only the verified
   forwarding suffix; never turn a visitor prefix into a selected identity.
6. Keep the app, worker, PostgreSQL and Valkey private with **no public published
   ports**. Only the ingress may reach the app's private port; isolate untrusted
   co-tenants from that network. Private addressing alone does not authenticate
   another container. Audit Docker's effective published ports and forwarding
   rules, not only `ufw`: Docker can divert traffic before those rules. See
   [Docker firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/#docker-and-ufw).
7. Protect Dokploy, SSH, metrics, dashboards and management APIs through a
   separate owner-only VPN or authenticated access route. No DNS-only admin
   hostname pointing at this origin; no internet-wide management listeners.
   If Dokploy shares Traefik with other apps, use an isolated listener/instance
   for this trust policy or have its owner review every router/TLS default on
   the shared listener. A catch-all router or weaker TLS option must not bypass
   chess's zone authentication. Do not change another app's ingress in this lane.

Range maintenance is an operator obligation. Fetch both lists over verified
HTTPS on a scheduled check (recommend daily) and before rollout; validate that
both are nonempty CIDR lists, review changes and retain the last approved
version/hash/time privately. Stage firewall and trusted-forwarder changes
together, reload atomically where supported, and re-run positive and negative
probes. A failed fetch/parse/reload must keep the last approved restrictive
policy, alert the owner and block rollout; never substitute an empty trust list
with “trust all.” Unexpected removal/addition or suspected compromise requires
owner review and, if trust cannot be established, closing ingress until fixed.
Certificate expiry and inability to refresh ranges must alert before outage.

## Header fixtures and proof before rollout

`apps/server/src/client-ip.public-proxy.fixture.json` contains synthetic inputs
at the **app boundary**, exercised by `client-ip.test.ts`. They prove resolver
selection and anonymous middleware bucket isolation, not real Traefik behavior,
firewall enforcement, mTLS or a running WS endpoint. Documentation-reserved
`192.0.2.10`/`2001:db8:1::10` stand in for edge peers, `198.51.100.7`/
`2001:db8::7` for visitors; none is an origin or a usable Cloudflare CIDR list.

| Fixture family | Expected result |
| --- | --- |
| `edge-traefik-*` valid IPv4/IPv6, optional source ports, forged prefix and conflicting CF/alternate IP headers | Visitor at exactly two from the right; ports stripped, bare IPv6 preserved |
| Short/missing/invalid selected entry, including invalid port | Socket key; CF header cannot rescue it |
| `normalized-ingress-*` with exactly one validated visitor | Visitor at one from the right |
| `wrong-hop-count-*` | HOPS=1 on a two-entry chain selects the edge; HOPS=2 on a one-entry chain selects the socket: neither is acceptable rollout evidence |
| Direct caller, zero hops | Socket, regardless of spoofed forwarding headers |

Run the named regression files during iteration:

```sh
pnpm exec vitest run apps/server/src/client-ip.test.ts apps/server/src/rate-limit.test.ts --maxWorkers=4
```

Before rollout, use **two independent external client networks**, with IPv4 and
IPv6 where available. In a short owner-controlled diagnostic window on the test
deployment, collect only the socket peer, XFF and selected key in restricted
records; do not add a public echo endpoint or log cookies, Authorization, claim
links or request bodies. Record the Git tree, pinned ingress version/config hash,
range versions, observed chains and expected client addresses. Remove temporary
diagnostics after testing. Compare captures with the fixtures before choosing
the hop value. Then verify:

- Each network gets its own anonymous limiter bucket; exhausting a test budget
  from one does not exhaust the other. Rotate forged XFF prefixes and CF/alternate
  IP headers from one network: its bucket must stay exhausted. Avoid real signup
  mail or locks on a real account; use the batched test setup's disposable route
  or recorded key instrumentation. A shared NAT can legitimately share a bucket.
- From a non-Cloudflare source, direct origin IPv4 and IPv6 requests (including
  correct Host/SNI, forged CF/XFF and WS upgrades) are refused before the app.
  Probe alternate ports and private service exposure too. The test must target
  the actual origin using a private address mapping, not public proxied DNS.
- Probe wrong/missing Host, wrong/missing SNI and both mismatches. To test the
  TLS/router layer despite firewall denial, use an owner-controlled isolated
  fixture at that layer; do not broaden production ingress just for a probe.
- An owner-controlled **different Cloudflare zone** pointing at the test origin
  must fail even with the expected Host/SNI and without this zone's custom
  client certificate. Global AOP alone and an IP allowlist would not prove this.
  The intended zone must succeed with its own certificate. Record denial layer
  and lack of app delivery, not merely an arbitrary edge error page.

These are owner/batched acceptance tests. Do not mark them passed based on the
synthetic unit fixtures. The activation checklist below records the required final public evidence.

## WebSocket contract

The landed runner transport uses `/api/cli/runner/ws`. It must resolve the canonical IP from the same socket
and exact XFF rule **before accepting an upgrade**. If the Node upgrade adapter
bypasses Hono middleware, explicitly wire this gate into that adapter; routing
HTTP through the resolver does not prove upgrade handling is covered.

Use a dedicated, bounded, **pre-auth IP connection/attempt budget** with its own
key prefix, separate from HTTP auth/signup/RPC limits and post-auth per-machine
limits. Failed authentication must spend that budget; missing identity must not
bypass it. Keep it effective across replicas, fail closed when its authority is
unavailable, and bound active sockets as well as attempts. No token in the URL,
no cookie/browser bearer authority on this runner surface, no raw frame/token
logging. Tests must show two external clients yield distinct upgrade keys and
forged CF/XFF cannot rotate either budget.

E2's liveness contract is a valid heartbeat about every **25 s**, closing after
about **60 s** without valid liveness. Pause new provider dispatch immediately
on transport loss and reconcile on reconnect; transport timeout is separate
from the match resume grace. Use 100 s only as a conservative **design budget**,
not a universal Cloudflare timeout claim. The actual edge idle/restart check
keeps a socket alive for more than 100 s with heartbeats, drops connectivity and
restarts the test origin, then checks bounded reconnect and no duplicated work.
Cloudflare can terminate sockets during edge updates and inspects the upgrade,
not subsequent application frames: application limits remain required. See
[Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/).

## Mail must not disclose the origin

Use an external authenticated SMTP relay over verified TLS, never a VPS SMTP
listener or direct port-25 delivery. For this public topology, recommend
`SMTP_PORT=465` with the relay's certificate-valid DNS hostname and both
`SMTP_USER` and `SMTP_PASS` supplied through the deployment secret store.
Nodemailer defaults to implicit TLS on 465; the existing mailer does not set
`requireTLS` for 587, so a generic STARTTLS-capable relay on that port is not
proof of mandatory TLS. A 587 variant requires separately reviewed enforced-TLS
transport and tests before adoption. Do not disable certificate validation.
See the [Nodemailer SMTP options](https://nodemailer.com/smtp).

`packages/mailer/src/index.ts` already bounds connection setup, idle time and
total send time. It does not strip headers added by a relay. Setting `SMTP_HOST`
or successfully checking the transport does **not** establish origin privacy.

Before public signup, send verification **and password-reset** messages through
the actual selected relay to an independent external mailbox. Use “show original”
or export the complete delivered message source, including folded headers;
inspecting the outbound message before submission is insufficient. Privately
check every `Received`, `X-Originating-IP`, `Authentication-Results`, `Received-SPF`,
`Return-Path`, DKIM domain, `Message-ID` and hostname/EHLO trace for the origin's
IPv4, IPv6, reverse DNS, internal hostname or a DNS name resolving to the VPS.
Include relay-added submission headers and retry delivery. Record only a
redacted pass/fail/provider/config/version summary publicly, never reset links,
addresses, mail source or the origin address.

If a relay preserves submission IP/hostname, require its supported stripping
policy, or use an owner-selected trusted outbound intermediary that demonstrably
removes the submission trace before final delivery; repeat both delivered-mail
tests. Do not add app-side header deletion and assume downstream headers vanish.
Keep activation blocked if the chosen service cannot meet this contract.

Inventory DNS and external breadcrumbs privately: current and historical A/AAAA,
DNS-only subdomains, old previews/admin names, MX, SPF `ip4`/`ip6`/`a`/`mx` chains,
relay hostnames, PTR/EHLO names, public logs/error pages and links in email. MX
and mail authentication records must describe the relay's delivery services,
not this VPS. Do not run inbound mail here. Orange-cloud DNS cannot erase old
DNS history or another service on the same address. If the origin was already
published, give the inventory to the owner to decide whether IP replacement is
needed; replacement is an owner operation, not an agent action. Keep ingress
restrictions even if a new address is selected.

## Tunnel alternative

An owner may instead choose the existing [Cloudflare Tunnel topology](./deployment.md#home-server-behind-a-cloudflare-tunnel).
It is outbound-only with private `cloudflared` → app (normally HOPS=1), or
`cloudflared` → restricted trusted Traefik → app (normally HOPS=2). Capture its
actual chain again. No public origin listener/CF range allowlist is needed for
that path; keep every origin/app/data/management bypass closed. AOP does not
authenticate a tunnel route; its connector credentials do. Do not reuse direct
proxy trust lists or expose both paths of different lengths to the same app.
Mail privacy and historical origin exposure still require the same audit.

Final release acceptance needs the exact
landed tree plus real ingress/mail/WS evidence above. No infrastructure change,
delivered-mail audit or live-edge success is implied by a green unit/Boat gate.

## Public launch configuration

The public service is `https://chess.flycockpit.app`, operated by FlyCockpit,
LLC in the USA. The contact is `contact@flycockpit.app`. Launch uses a send-only
relay; receiving contact mail is a separate prerequisite. No DNS, firewall,
provider, system service, tag, npm publication or deployment is performed by
this runbook. Owner-only actions below are recipes to review and execute in the
owner's operational environment. Keep their evidence restricted and redact it
before sharing.

The [public Compose fixture](./fixtures/public-hosting/compose.json) is a
reviewable public-specific configuration, **not the unmodified output of
`pnpm dokploy:config`**. It retains the generator's service names (`server`,
`worker`, `postgres`, `redis`, `backup`), image commands and persistent data
layout, so the existing backup helper works. It deliberately differs in ingress,
retention, required secrets, deletion storage and activation switches. Use it
as the public Compose file after reviewing it against the approved final SHA;
do not merge its services with a second generated stack or start two schedulers.
Generic signup/chess/backup code defaults remain off.

`CHESS_COMMIT` is a **Compose/build interpolation input**, not a new application
environment variable. Supply an approved full lowercase 40-character Git SHA,
never `main`, a moving branch or a version nickname. The server and worker build
contexts and `BUILD_VERSION`, and the backup image, all use that same SHA.
Disable Dokploy auto-deploy for public production. This fixture needs no Git
release tag: the owner controls any later tag/release separately. Inspect image
identity with the existing deployment verifier. Secret placeholders have no
usable defaults and must be filled through Dokploy's restricted Environment
store, never a committed file. Database/cache passwords interpolated into URLs
must be URI-safe; separately supplied connection strings must be complete literal
values. Docker configuration is privileged and still contains startup secrets.
Do not print `docker compose config` or `docker inspect` with real credentials.

For a **synthetic placeholder-only** validation, `docker compose -f docs/fixtures/public-hosting/compose.json --profile backup config --quiet`
checks the rendered Compose once the required inputs are supplied. This does
not start services. The fixture regression is part of `pnpm dokploy:test`.
Never treat parsing as proof of firewall, capacity, storage or mail behavior.

### Owner provisioning and activation order

1. Approve the final legal pages and processor inventory, and complete the DNS,
   origin-authentication, exact-hop and delivered-mail proofs above. Prefer a
   dedicated public VPS/ingress. Use the owner-reviewed private
   `dokploy-network` ingress network on this dedicated chess VPS; attach the
   restricted Traefik listener and the server, with no untrusted containers.
   The name matches the existing helper's ingress-network exclusion, so operations
   select the project's separate default network containing PostgreSQL. The fixture publishes **no** app,
   PostgreSQL or Valkey ports. Only owner ingress may expose HTTPS.
2. Provision `/srv/cockpit-chess/backups` and the **separate**
   `/srv/cockpit-chess/account-deletions` storage before creating containers.
   The register bind sets `create_host_path=false`. Backups use a named
   local-driver volume bound to the reviewed host path, with copy-up disabled;
   Docker refuses its mount when the host directory is missing. The name lets
   the existing helper discover `/backups` for list/restore/drill operations. Both need the image runtime's ownership (currently UID/GID
   `1000:1000`); the register directory must be `0700`, records `0600`, with no
   symlinks. Verify identity on the selected image. Use host disk encryption for
   local database, cache and dump storage. Every server/worker and the daily backup container sees the same
   current register at `/account-deletions`; multi-host replicas require a
   restricted shared filesystem with working atomic links and fsync. The daily writer mounts the
   register read-only for checkpointed backups; deletion writers mount it read-write. See
   [suppression and host loss](#suppression-and-host-loss).
3. Provision the off-VPS bucket, encryption, lifecycle, independent register
   protection, log expiry and alerts described below. Escrow auth pepper and
   provider-key encryption secrets separately from dumps, with the keys needed
   by any still-restorable backup. `CHESS_PROVIDER_KEY_SECRET` must be the same
   64-hex value on server and worker; follow the existing
   [rotation recipe](./deployment.md#rotating-the-provider-key-secret) rather
   than overwriting it. Never put keys into browser variables, fixtures or logs.
4. Start exactly one external worker and one server, both from the same SHA;
   server `WORKER_MODE=external`, `MIGRATE_ON_START=true`; worker
   `MIGRATE_ON_START=false`. The server alone admits migrations, and the worker
   waits up to 300 seconds. Preserve the images' **510-second startup allowance**
   and 30-second shutdown grace. PostgreSQL 18 and Valkey 9 have persistent
   volumes; Valkey uses AOF and `noeviction`. Enable the **backup profile** for
   exactly one `backup-schedule` service. No second cron/daily writer for this DB.
5. Keep `SIGNUP_ENABLED=false`, `CHESS_HOSTED_ENABLED=false` and
   `CHESS_USER_MATCHES_ENABLED=false` during installation and bootstrap. Bootstrap the first admin through the existing
   [setup-key procedure](./deployment.md#first-admin-user), remove `SETUP_KEY`
   afterwards, and complete forced admin 2FA. Do not change verification,
   password, 2FA, ban, CSRF or rate-limit policies. The public fixture leaves
   operator `OPENROUTER_API_KEY` unset; ordinary users supply their own connection.
6. For **restricted acceptance**, first restrict edge access to the owner's
   test networks without changing the proxy/header/WS path; then explicitly set
   `SIGNUP_ENABLED=true`, `CHESS_HOSTED_ENABLED=true` and
   `CHESS_USER_MATCHES_ENABLED=true` on the roles receiving those settings and
   recreate them with the same approved SHA. Complete the checklist while access
   stays restricted. Only after it is signed may the owner open public traffic
   with those flags enabled. Keep `BETTER_AUTH_URL` and
   `PUBLIC_APP_URL` exactly `https://chess.flycockpit.app`; leave `CORS_ORIGIN`
   and build-time `VITE_SERVER_URL` unset for same-origin requests. No tracking
   analytics configuration, third-party scripts/fonts/embeds or consent banner
   activation. Build opt-outs are set before tool installation in **both**
   Dockerfiles: `TURBO_TELEMETRY_DISABLED=1`, `CHECKPOINT_DISABLE=1`,
   `REACT_DOCTOR_NO_TELEMETRY=1`; use `--no-telemetry` for a manual React Doctor.
7. Run `pnpm deploy:check https://chess.flycockpit.app --commit <approved-sha>`
   through the actual edge. Readiness must identify that exact commit and healthy
   migration/worker admission; a successful image build or HTTP 200 alone is
   insufficient. Record source-download and full project-batch acceptance before
   the owner publishes npm or declares launch. No publishing step is delegated
   to an agent by this document.

The fixture retains **512 hosted slots per worker process**, queue maximum 200,
20 own-key starts per rolling day, one active own-key match, and the existing
12 creates/hour procedure budget. It explicitly sets the engine pool to **2**
(single-thread bounded engine children), not 512 engine processes. One worker
is an initial topology, not evidence a VPS can safely fill all slots: measure
CPU/RAM/DB pool/queue latency with representative engine-node/time budgets while
still restricted. If that machine cannot meet limits, choose and record a lower
**deployment** concurrency before enabling hosted flags. Do not lower a shared
rate budget to conceal capacity or multiply worker replicas without measuring
the aggregate. The server and worker each have a 10-connection DB pool.

### Edge, cache, static source and runner settings

On the dedicated Traefik `chesssecure` entrypoint, use only the current full
Cloudflare IPv4/IPv6 ranges for `forwardedHeaders.trustedIPs`, keep
`forwardedHeaders.insecure=false` and PROXY protocol disabled, and preserve the
measured `[visitor, edge]` suffix for **HOPS=2**. The fixture's value is conditional
on that measured chain; use neither a one-hop direct bypass nor an extra proxy.
Apply the [TLS dynamic fixture](./fixtures/public-hosting/traefik-tls.json) to
that dedicated listener through the file provider. Provision the referenced
origin certificate/key and **this zone's dedicated** client CA outside Git with
restricted permissions. There is no public HTTP-01/certresolver fallback in the
fixture. Keep unknown SNI/Host and another Cloudflare zone denied, and do not
merge this trust domain into a shared weaker TLS default. Firewall and range
refresh remain owner-managed per the earlier contract.

Enable Cloudflare WebSockets for the hostname and preserve HTTP/1.1 upgrade
through Traefik on `/api/cli/runner/ws`. No token or claim proof belongs in an
edge URL/log. Application/native heartbeats run every **25 seconds**, liveness
expires around **60 seconds**, and the separate gameplay reconnect grace is
**120 seconds while clocks continue**. The CLI pauses new inference on transport
loss and reconciles accepted sequence/journal work; a rolling restart must not
redispatch uncertain inference. Password reset, revoke and deletion fence
immediately without granting reconnect grace. Preserve the dedicated pre-auth
canonical-IP and post-auth machine connection/action budgets.

The origin enforces `Cache-Control: private, no-store` for every HTML document
(anonymous and signed-in, including internal SSR cache hits), `/api` and `/rpc`
responses, `/ready`, `/health`, `version.json`, redirects and errors. Responses
carrying `Set-Cookie` are always private/no-store, even on a static URL. Stricter
route directives such as `no-cache` and `max-age=0` are retained. The bounded
anonymous SSR cache remains internal to the server; its HTTP responses cannot
be stored by browsers or shared caches.

Successful content-fingerprinted `/assets/*` files retain
`public, max-age=31536000, immutable`. Non-fingerprinted public files, including
`robots.txt`, `sitemap.xml`, `llms.txt`, the Stockfish source archive and adjacent
licence/checksum files, use `public, max-age=300, must-revalidate`: five minutes
allows shared delivery while bounding deploy staleness; stale copies must be
revalidated rather than served during an origin outage. Missing assets are
uncached 404s. `index.html` and `version.json` are never cached.

Keep the Cloudflare bypass rule as a second layer of protection even though
the origin now supplies these headers. Bypass cache for HTML, localized pages, `/api/*`, `/rpc/*`, auth,
claim/control, export/download responses, `/ready`, `/health` and `version.json`.
Keep query strings/Authorization/cookies out of cache keys by **not caching these
responses at all**. Do not add a Cache Everything rule. Only the public static
files described above may use shared caching within their origin TTLs.
Respect origin `no-store`, MIME types and security headers;
never strip or replace the app's nonce/hash CSP or add unsafe directives.
No browser engine, third-party script or extra CSP permission is needed.

Keep anonymous HTTPS GETs to `/third-party/stockfish/` outside authentication,
challenge/interstitial and SPA rewrites, including:

- `stockfish-19.0.1-source.tar.gz`, SHA-256
  `f3de92f59596949123390c9f1dfe66dd4cbbaafe4b7faf20446edcd6d99cc2d1`;
- adjacent `Copying.txt`, `AUTHORS` and `SHA256SUMS` staged by E6;
- `BUILD.md` **inside the extracted source archive**, with the build instructions
  (inventory these from the actual built image).

Download through the edge and verify checksum, archive contents and adjacent
notices before owner npm publication. Keep the corresponding source at that
stable URL **for as long as the engine is distributed**, including across later
releases or a site retirement; preserve older version directories in durable
public storage if an image no longer contains them. This source-distribution
archive contains public code, so it is excluded from personal-data backup expiry.
An HTML fallback, login page, edge challenge or cached 404 is a failed source
check. Static hosting must preserve the app's security headers; no CSP loosening.

## Public retention and recovery

The owner's public policy is daily encrypted backups off the VPS, **30-day
backup expiry**, operational logs for **at most 30 days**, and a durable deletion
register. These are explicit public-deployment requirements. Generic backup-off,
14-days-with-dumps defaults are not evidence this policy is active.

### Database backups and expiry

The public fixture explicitly sets `BACKUP_ENABLED=true` on server and worker,
`BACKUP_SCHEDULE=daily` and `BACKUP_KEEP=30` on the single backup service, and
`BACKUP_MAX_AGE_HOURS=26` on server/monitor. The daily hour is 03:00 UTC, with
hourly retries. Server startup and explicit backup operations use a dedicated
read/write backup identity; the worker receives a separate **ListBucket-only**
monitor identity. Both use the same deployment-specific database prefix.
Writer credentials are stripped before app execution, though privileged Docker
configuration still contains startup credentials. Monitor credentials cannot
read dumps. Alert externally on daily service unhealthy, no uploaded completed
object in 26 hours, failed register protection, retention maintenance failures,
disk pressure, certificate expiry and stale ingress ranges. An admin card alone
is not an alert delivery mechanism; send and confirm a test notification.

Use a **new dedicated bucket that has never had versioning enabled**, public
access blocked, outside the VPS failure domain, HTTPS transport, no replication
or secondary archive with a longer lifetime, and no Object Lock/legal hold.
This public recipe selects conditional unique-name no-overwrite uploads rather
than version history. Do not suspend a formerly versioned bucket and assume its
old versions disappeared. If versioning/PITR/replication is introduced later,
the owner must first prove a 30-day maximum for **every restorable version and
copy**, including an overwritten object's earlier content. Current-version
expiration alone on a versioned bucket leaves restorable versions behind. See
[AWS lifecycle semantics](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html).

Apply the native S3 [encryption fixture](./fixtures/public-hosting/bucket-encryption.json)
and [lifecycle fixture](./fixtures/public-hosting/bucket-lifecycle.json) to that
bucket. The fixture uses AWS S3 in an owner-chosen region, with
`BACKUP_S3_SSE=AES256` on both writers, default AES256 server-side encryption,
and 30-day expiration on the **whole database prefix**. It covers daily,
manual, pre-migration, pre-drop and pre-restore dumps, and aborts incomplete
multipart uploads after one day. Keep HTTPS required and give the writer
GetObject/GetObjectVersion/PutObject/AbortMultipartUpload on only that prefix,
no object deletion or bucket administration; constrain the monitor ListBucket
prefix separately. Storage encryption protects stored dumps, not against a
compromised provider account: restrict provider access and MFA. A client-side
or KMS encryption scheme is not implemented by this fixture. Do not use a
provider that silently ignores AWS SSE or lifecycle semantics without a separate
verified recipe.

Record the effective bucket policy, public-access block, never-enabled versioning
status, encryption and lifecycle configuration, an uploaded object's encryption
metadata/ETag, and an isolated restore result. Lifecycle expiry is scheduled by
the provider; physical deletion may finish asynchronously. Check actual expiry
and access to expired objects rather than claiming precise physical erasure at
an instant. No indefinite historical versions, snapshots, offsite sync archives
or provider recovery points may remain available beyond the policy window.

`BACKUP_KEEP=30` counts **UTC days containing dumps**, not elapsed calendar days;
manual/pre-restore dumps otherwise have no automatic local pruning. Apply the
[hourly retention service](./fixtures/public-hosting/chess-retention.service)
and [timer](./fixtures/public-hosting/chess-retention.timer) on this dedicated
VPS after owner review. Its fixed local backup path matches the Compose bind;
it expires completed `.dump` files **and `.dump.*` partial/companion files**
after 29 days, leaving room for the hourly
schedule within the 30-day ceiling, even if the daily writer stops. The register
is deliberately outside that path. Do not place gzip/manual archives elsewhere
and forget them: inventory and apply equivalent expiry to every other local,
provider/PITR or exported copy, or do not create it. Restrict local dumps to
UID1000 and encrypted storage. The generic newest-five pre-migration/pre-drop
limits are additional size protection, not an age limit.

With backups enabled, missing writable destination/credentials or a failed
required dump refuses migrating startup, including a fresh install. A local
mount alone can satisfy the tooling, so independently require the **off-VPS
upload** and monitor evidence before activation. Never turn backups off to
force a public launch through an unexplained failed dump.

### Operational logs

All five Compose services use Docker's `journald` driver. On this **dedicated
chess VPS**, the owner installs the
[journal drop-in](./fixtures/public-hosting/journald.conf) and hourly retention
service/timer. `MaxRetentionSec=29day`, `MaxFileSec=1h`, hourly rotate/vacuum and
size caps keep the planned window below 30 days; disk limits can shorten it.
Do not apply this global host policy to a shared VPS without its owner's review.
The timer must stay enabled and its failures alert. See
[Docker journald](https://docs.docker.com/engine/logging/drivers/journald/) and
[systemd retention controls](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html). A Docker `max-size`/`max-file`
setting alone is not age retention. No app/file log directory may bypass it.

Keep Traefik access logs **disabled** for launch (especially claim URLs and
query strings); send its operational warning/error logs to the same journal.
Keep PostgreSQL logging to container stderr and Valkey to stdout; do not enable
persistent query/body/frame logging. Inventory Dokploy deploy/build logs,
system/auth logs, crash dumps, error notifications and any Cloudflare/provider
log export separately. Give them the same maximum age, restricted operator
access and no log backups with a longer lifetime. Disable optional Cloudflare
Web Analytics, browser Insights/beacons, Logpush exports and visitor tracking;
use only necessary proxy/security processing. Provider-mandated retention is a
processor disclosure/owner approval matter, not something journald can enforce.
Do not claim it passed until the provider's effective retention is recorded.

Prove the effective journal settings and timer schedule in owner evidence. In
an isolated fixture journal and backup directory, age synthetic records/dumps
past the threshold, run the same maintenance policy, and show expired items
are unavailable while recent ones survive. Verify every container's logging
driver and the oldest retained record after maintenance. Do not test by deleting
production logs. Never log mail sources, cookies, tokens, claim links, exported
account data, raw model frames or private request bodies for this acceptance.

### Suppression and host loss

`ACCOUNT_DELETION_REGISTER_DIR=/account-deletions` is independent of DB backup
enablement. The register is **not** a database dump, a DB snapshot sibling, or
a directory to roll back with the application. D2b fsyncs restricted records
before deletion acceptance; an unavailable register blocks acceptance or leaves
cleanup pending. The owner must provision it and its independently encrypted,
access-controlled off-VPS protection before enabling account use. Prefer a
filesystem with synchronous off-VPS durability for committed records; verify
that acknowledged fsync/atomic-link operations survive loss of this VPS. Keep
an independently managed current recovery copy, test reconstruction and alert
on protection failure. This filesystem/replication service is **not supplied by
Compose**, and an empty directory on a replacement VPS is not proof of a
complete register. A daily register snapshot alone can lose today's erasures.

The strict v2 register is an append-only sequence/digest chain. Keep the **entire
chain**, including every record for at least 31 days, while any earlier backup
remains restorable. Individual entries cannot be pruned without breaking
ancestry. Inventory manual/pre-restore copies, noncurrent versions, provider
recovery points and abandoned drill artifacts before any owner-reviewed
whole-register retirement. No automatic pruning is configured; advisory expiry
is not deletion authority. Use a separate storage namespace and protection policy,
never the database-prefix 30-day lifecycle. Maintain a restricted inventory of
restorable DB copies and current register generation/completeness evidence.
If the current register cannot be recovered after host loss, keep app/worker
admission and public traffic closed: restoring a last-night register and serving
traffic could resurrect an account deleted this morning. Resolve completeness
with the owner before any restart; do not invent an empty register.

### First release, upgrade, restore and rollback

The first public release ships `0_init` **plus every landed chess migration
folder unchanged**. Baseline `21528cdafa8a4dd64c83f0a4ebe7e3e4708ac44d`
had that same `0_init`; never squash the first release into a new baseline.
Only a later tagged release with a real previous release tag uses the
[release squash](./schema-migrations.md#the-release-procedure). G1 has no migration.
This is one current prerelease schema/archive/protocol shape. Unsupported
prerelease archives fail cleanly; there is no mixed-worker/old-CLI rollout or
promise that a pre-feature image can read the current database.

Run the existing offloaded migration checks on disposable PostgreSQL: a fresh
install and a replay starting with the baseline `0_init` plus representative
users/private and published/previously-official games, then each new migration
and every `.check.sql` assertion. The fixture chain checks retention/redaction
and official-ledger behavior, not invented automatic enrollment of old games.
Do not run against a real/shared DB. Include the existing backup/restore and
runtime-operation integrations; the suppression regression must restore a
pre-erasure dump using the complete current register and prove access stays
blocked. Run owner recovery drills on an isolated destination, never production.

**Recovery requires independently verified current evidence.** The procedure
below is defined; public restore activation still requires the owner to prove
the independent protection/freshness and isolated drill in the checklist.
A readable register, backup checkpoint, timestamp or assertion alone cannot
establish that the copy covers the final accepted deletion. If currentness
cannot be established after host loss, keep admission closed.

1. Use the approved current image for **all** manual, daily, migration and
   pre-restore backups, with the complete current register mounted. The existing
   helper takes a manual backup with `bash app-db.sh backup --project cockpit-chess-public`.
   A verified head is captured before the dump and again after it; the latter
   must extend the former. The `.dump` file is a **checkpointed backup envelope**
   containing the post-dump head and dump-body checksum. Concurrent deletions
   are conservatively included. Preserve that whole file/object, ETag and
   version. The checksum is not a signature, and the backup-time head is not
   proof of the current head at recovery time. Old raw/unchained prerelease
   formats are refused; normal deletion writes require the strict v2 chain.
2. For recovery, stop/drain **every** app, worker, scheduler, migration leader and
   external writer first, disable auto-deploy/restarts and block ingress. Recover
   the independently protected **complete-current full chain** through the last
   acknowledged deletion. Establish its provenance/freshness outside the DB and
   suspect restore mount. Keep it separate from every DB/host rollback domain.
3. Set the operator shell values `APP_IMAGE` to the recorded immutable app image
   and `PROTECTED_REGISTER_COPY` to that independently verified recovered
   directory. These are shell values, not new app environment variables; neither
   has a guessed default. The directory/records must match the image runtime UID
   and restricted permissions above. Extract and record the trusted head with
   networking disabled and no DB/Redis credentials:

   ```bash
   : "${APP_IMAGE:?set the approved immutable app image}"
   : "${PROTECTED_REGISTER_COPY:?set the independently verified complete-current copy}"
   TRUSTED_REGISTER_HEAD="$(docker run --rm --network none --entrypoint node \
     --mount "type=bind,source=$PROTECTED_REGISTER_COPY,target=/account-deletions,readonly" \
     -e ACCOUNT_DELETION_REGISTER_DIR=/account-deletions "$APP_IMAGE" \
     /app/scripts/backup/account-deletion-suppression.mjs head)"
   printf '%s\n' "$TRUSTED_REGISTER_HEAD"
   ```

   Stop if extraction fails or independent currentness is unproven. The token
   is `<sequence>:<sha256>` and is not a secret; its authenticity/freshness are
   critical. Never derive it from the suspect mount, restored DB or archive.
4. Mount the recovered full register read-only for recovery. Its head must
   **exactly equal** that independently trusted current token. A longer suffix
   is unauthenticated until independently reverified; a valid old prefix, fork
   or empty stale directory refuses. The backup checkpoint must also be an
   exact ancestor. A genuinely empty register only passes with independently
   current genesis (`0:` plus 64 zeroes) and a genesis backup checkpoint.
5. Choose the exact source from `bash app-db.sh list` as shell value
   `BACKUP_SOURCE`, then have the owner run the existing guided helper/drill:

   ```bash
   : "${BACKUP_SOURCE:?choose the exact checkpointed backup source}"
   : "${TRUSTED_REGISTER_HEAD:?recover the independent current head first}"
   bash app-db.sh restore "$BACKUP_SOURCE" --project cockpit-chess-public \
     --expected-register-head "$TRUSTED_REGISTER_HEAD"
   bash app-db.sh drill "$BACKUP_SOURCE" --project cockpit-chess-public \
     --expected-register-head "$TRUSTED_REGISTER_HEAD"
   ```

   Restore shows a preview and asks for target confirmation; an S3 source is
   pinned in that guided preview. For an S3 **drill**, also pass its recorded
   `--etag` and optional `--version-id`. Direct image jobs use
   `restore <source> --expected-register-head <trusted-current-head>` for the
   preview, then the same command with `--confirm RESTORE:<target-db>` and
   `--replace` only when replacing a nonempty target. Direct drills use
   `restore-drill <source> --expected-register-head <trusted-current-head>`.
   S3 direct jobs additionally need exact ETag/optional version pins. Supply the
   target network, existing injected DB/backup settings and mounts, not real
   secrets in command text. See [the complete owner procedure](./backup-restore.md#account-erasure-suppression).
6. For provider PITR, volume recovery or a raw export, recover into an isolated
   DB with **no application admission**. Run the current image's `backup` command
   against **that isolated DB's** injected `DATABASE_URL`, with the verified
   complete-current register and a writable backup destination. This creates a
   checkpointed envelope; conversion does not suppress the intermediate DB.
   Finally use guarded `restore` of that envelope into the intended final target
   with the independently current expected head before starting any consumer.
   A schema hold or successful conversion never authorizes admission.

For an actual restore, stop every server, worker, daily writer, migration leader
and external DB writer, block public ingress, and prevent auto-restarts/deploys.
Follow the existing [guarded restore](./backup-restore.md#restore): preview the
exact ETag/version-pinned source inside the target network, then have the owner
supply its exact confirmation after reviewing the target and safety snapshot.
Mount the **complete current register read-only**, owned by the runtime UID,
and supply the independently verified `--expected-register-head` above. The
tool checks exact current-head equality and backup-checkpoint ancestry, repeats
those checks after writers drain, and reapplies suppressions in the same
restore transaction **before COMMIT/admission**. Missing/malformed/incomplete
register evidence keeps traffic closed. Never use an active-writer bypass.

The host helper restarts previously running writers after a confirmed success
or a provable refusal/rollback; keep **edge traffic blocked** throughout so this
is not automatic public admission. For manual one-shot operations, explicitly
select the project default network, the named backups volume and current
register mount; never rely on an unmounted image directory.

After restore, start the current approved image in isolation, with the current
register writable for ongoing deletion cleanup. Confirm erased credentials,
runner authority and private games do not return; retained published replays
are scrubbed with neutral URLs, hidden replays stay hidden, and official starts
remain counted. Confirm pending physical cleanup completes before reopening
traffic. Provider PITR/snapshots must first be isolated and converted by the
current guarded `backup` command to a checkpointed envelope, then restored
through the guarded path with the independently current expected head. A seven-day schema
hold is not erasure reapplication. Inventory and expire the pre-restore safety
copy too.

For rollback, inspect the runner's DB-ahead/admission verdict and
[recovery instructions](./schema-migrations.md#rollbacks). A refused older image
is not a reason to reset a DB, edit applied checksums or bypass admission.
Prefer a fix-forward build; an owner-approved data recovery uses the guarded
restore and current suppression register. Any uncertain restore COMMIT requires
inspection before retry. Keep all roles pinned to one approved current shape.

## Public activation evidence checklist

Keep this signed record for the actual deployed tree, ingress config hash and
provider configuration versions. A repository/Boat pass does **not** check these
external facts. The batched project acceptance owns the live/browser rows.

- [ ] Final landed F1 results and D1 legal pages match actual behavior and name
  `contact@flycockpit.app`; owner approves terms/privacy/processor disclosures.
- [ ] **contact@flycockpit.app receives mail (send a test and confirm delivery)**,
  including before the flycockpit.app mail server is launched.
- [ ] DNS/history/mail breadcrumb inventory, IPv4+IPv6 direct/alternate-port
  refusal, Host/SNI/other-zone denial, Full (strict), dedicated zone mTLS,
  current CF ranges and two-network exact-hop/spoof/limiter evidence pass.
- [ ] Actual verification and reset messages pass delivered-header privacy and
  authentication checks through the selected TLS465 relay; no origin IP leaks.
- [ ] Same SHA on all images, first-release migration folders unchanged,
  510-second admission allowance, no public data ports, one worker and one daily
  scheduler, encrypted persistent storage and measured capacity are recorded.
- [ ] Uploaded daily backup is encrypted and off-VPS, 30-day lifecycle applies
  to every DB copy, no hidden versions/holds, monitor/failure alerts delivered,
  local expiry/journal expiry tested and provider retention recorded.
- [ ] Current register survives DB replacement **and host loss**; independent
  encrypted complete-current chain/head, permissions, full-chain retention and
  no-early-prune policy proven; pre-erasure restore drill denies resurrected authority before serving.
- [ ] Through the actual Cloudflare hostname at desktop1440×900 and phone390×844,
  en-US/es-MX: signup/verify/2FA, OpenRouter own-key consent, practice/official
  pre-start choice, hosted human play, claim/run/control/limits, revoke/reset,
  export/delete, anonymous report/admin hide and statement-of-reasons all pass.
- [ ] Runner survives >100 seconds with heartbeats; forced edge reconnect and
  origin restart reconcile once, lost liveness pauses dispatch, clocks continue,
  120-second grace expires, revoke/reset/delete fence immediately.
- [ ] Stable Stockfish source URL downloads bytes with E6 checksum and notices;
  app AGPL source link works; durable source retention is assigned an owner.
- [ ] `deploy:check` through the edge identifies the approved commit, telemetry
  opt-outs are effective, no tracking is configured, and secret escrow tested.
- [ ] Real OpenRouter account/credit-limited owner consent and npm publication
  are explicitly owner-run. Record any untested leg and keep its launch gate open.
