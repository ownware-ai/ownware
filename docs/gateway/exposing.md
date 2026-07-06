---
title: Exposing the gateway
description: How to take an Ownware gateway beyond localhost — the bind-safety invariant, the persistent token, TLS choices, and the deploy checklist.
type: how-to
---

# Exposing the gateway

By default the gateway binds `127.0.0.1` — trusted, plain-HTTP-friendly,
copy-paste simple. This page is for the moment you want other machines
(your phone, your team, a webhook) to reach it.

**For AI agents:** the invariant is enforced in
`packages/cortex/src/gateway/server.ts` (bind classification + boot
refusal); the token persists at `<dataDir>/gateway-token` (0600); a
host-header guard rejects DNS-rebinding on exposed binds.

## The invariant (you cannot boot unsafe)

The gateway classifies its bind address at boot:

| Bind | Auth | TLS |
|---|---|---|
| Loopback (`127.0.0.1`, `::1`, `localhost`) | off by default (opt in: `OWNWARE_REQUIRE_AUTH=1`) | off with `ownware serve` default, on for the library default |
| Anything else (`0.0.0.0`, a LAN IP, a hostname) | **forced on** | **forced on** |

Trying to combine a non-loopback bind with `--no-tls` /
`OWNWARE_GATEWAY_TLS=0` / `disableAuth: true` doesn't produce a warning — it
**refuses to boot**. There is no safe unauthenticated LAN bind, so Ownware
doesn't offer one.

Two guards ride along on exposed binds:

- **Host-header guard** — requests whose `Host` doesn't match the served
  names are rejected, defeating DNS-rebinding attacks from a browser tab.
- **Rate limiting** — `/run` and general routes are capped per window
  (`OWNWARE_RATE_LIMIT_RUN` / `OWNWARE_RATE_LIMIT_GENERAL`).

## The token

With auth on, every request needs:

```
Authorization: Bearer <token>
```

The token is generated once and **persists at `<dataDir>/gateway-token`
(mode 0600)** across restarts — clients don't chase a new secret every
boot. `ownware serve` prints it when auth is on. First-party clients
(`ownware schedule`, `ownware channel start`, `ownware-channel`) read that file
automatically; override with `--token` or `OWNWARE_GATEWAY_TOKEN`. In code:
`gateway.token`. The one route that never needs it: `GET /api/v1/health`.

## TLS: self-signed by default

The gateway provisions a per-install self-signed certificate under
`<dataDir>/tls/` and serves HTTP/2 over it. Depending on who connects:

- **Your own clients/scripts** — pin or trust the cert
  (`gateway.tlsFingerprint` exposes its SHA-256), or connect with
  certificate verification against that CA file.
- **Browsers / third parties** — put a real certificate in front: either
  terminate TLS at a reverse proxy (Caddy/nginx/Traefik with Let's Encrypt)
  and run the gateway loopback-only behind it (`OWNWARE_GATEWAY_TLS=0` is fine
  there — the proxy owns the wire), or use a tunnel (Tailscale/cloudflared)
  and keep the gateway on loopback.

The reverse-proxy/tunnel pattern is the recommended production shape: the
gateway never faces the internet directly, and the bind-safety invariant
still protects the internal hop.

## Checklist

1. `ownware serve --host 0.0.0.0` (or front a loopback gateway with a proxy).
2. Note the printed token, or read `<dataDir>/gateway-token`.
3. Clients send `Authorization: Bearer <token>`.
4. Browsers involved? Real cert via proxy/tunnel — don't ship self-signed
   to strangers.
5. In-process channels are skipped on TLS binds (the runner won't trust a
   self-signed cert) — run `ownware channel start --gateway <url>` against the
   proxied URL instead.

## Next steps

- [Security overview](../security/overview.md) — the layers below the bind.
- [Configuration reference](../reference/configuration.md) — every knob.
