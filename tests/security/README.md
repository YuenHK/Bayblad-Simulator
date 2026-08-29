# Production edge security tests

The production test run requires both `SECURITY_HTTP_ORIGIN` and
`SECURITY_HTTPS_ORIGIN`. Certificate verification is strict by default.

For a local Caddy CA, prefer setting `SECURITY_TLS_CA_FILE` to the absolute path
of its PEM root certificate. The Node Socket.IO client will trust only that CA
and will keep `rejectUnauthorized: true`. Set `NODE_EXTRA_CA_CERTS` to the same
file **before starting pnpm** so Playwright's HTTPS request client also trusts
the local CA.

`SECURITY_TLS_INSECURE=true` is an emergency local-only fallback. It is accepted
only when `SECURITY_HTTPS_ORIGIN` is a loopback URL (`localhost`, `127.0.0.0/8`
or `::1`). It must never be set in CI or a public deployment. Any other value,
including `TRUE`, is rejected instead of silently weakening TLS.

Use `SECURITY_ALLOW_SKIP=1 pnpm test:security` only for an explicit local run
where no production Compose/TLS stack exists. CI must run `pnpm test:security`
without that variable so a missing stack fails immediately.
