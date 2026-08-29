# Production edge security tests

The production test run requires both `SECURITY_HTTP_ORIGIN` and
`SECURITY_HTTPS_ORIGIN`. Certificate verification is strict by default.

For a local Caddy CA, prefer setting `SECURITY_TLS_CA_FILE` to the absolute path
of its PEM root certificate. The Node Socket.IO client will trust only that CA
and will keep `rejectUnauthorized: true`. Set `NODE_EXTRA_CA_CERTS` to the same
file **before starting pnpm** so Playwright's HTTPS request client also trusts
the local CA.

Certificate verification cannot be disabled, including on loopback. CI first
proves the untrusted connection fails, exports Caddy's exact local root, and
installs it in both the operating-system and Chromium NSS trust stores.

Use `SECURITY_ALLOW_SKIP=1 pnpm test:security` only for an explicit local run
where no production Compose/TLS stack exists. CI must run `pnpm test:security`
without that variable so a missing stack fails immediately.
