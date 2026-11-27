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
public proxy chain. No generator, environment defaults, schema or API is changed
by this contract. The existing deployment guide's tunnel instructions describe
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
synthetic unit fixtures. G1 records final public activation evidence.

## WebSocket contract for the runner lane

The runner transport is implemented by E2; A3 adds no WS route or dependency.
On `/api/cli/runner/ws`, E2 must resolve the canonical IP from the same socket
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

## Tunnel alternative and handoff

An owner may instead choose the existing [Cloudflare Tunnel topology](./deployment.md#home-server-behind-a-cloudflare-tunnel).
It is outbound-only with private `cloudflared` → app (normally HOPS=1), or
`cloudflared` → restricted trusted Traefik → app (normally HOPS=2). Capture its
actual chain again. No public origin listener/CF range allowlist is needed for
that path; keep every origin/app/data/management bypass closed. AOP does not
authenticate a tunnel route; its connector credentials do. Do not reuse direct
proxy trust lists or expose both paths of different lengths to the same app.
Mail privacy and historical origin exposure still require the same audit.

A3 hands the measured-chain fixtures and ingress/mail checklist to G1, and the
upgrade budget/liveness contract to E2. Final release acceptance needs the exact
landed tree plus real ingress/mail/WS evidence above. No infrastructure change,
delivered-mail audit or live-edge success is implied by a green unit/Boat gate.
