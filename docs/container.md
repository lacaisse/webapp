# Running La Caisse as a container

Production runs on Vercel and does not use anything in this document. This is how the same code runs as a container on Citizen Pay's self-hosted platform (builder, runner, lockbox). Staging (`APP_DOMAIN=staging.lacaisse.eu`) is the first user.

Files: `Dockerfile`, `.dockerignore`, `docker/release.mjs` (release command), `docker/collect-deps.mjs` (build helper), `scripts/seed-staging.ts` (synthetic seed).

## Build

```sh
docker build -t lacaisse-webapp .
```

- **Build arguments: none.** The app reads no `NEXT_PUBLIC_*` variable, so nothing is baked into the client bundle at build time. The builder entry for this repository has an empty `build_args`. (`NEXT_PUBLIC_APP_DOMAIN` in `.env.example` is read by nothing.)
- **No secret and no database at build time.** `next build` only needs `DATABASE_URL` to be present: `services/db/prisma.ts` throws at import without it while Next collects route configuration. The Dockerfile sets a placeholder (`postgresql://build-placeholder@127.0.0.1:9/none`) for that one `RUN` only; nothing connects to it. No other variable is needed, and no environment value ends up in a prerendered page (checked by building with sentinel values and searching `.next/`).
- The build log shows 14 lines `BetterAuthError: You are using the default secret` while Next prerenders: Better Auth refuses to start without `BETTER_AUTH_SECRET`, Next drops those prerender attempts, and the route table is the same as a build with a secret. Nothing is wrong; the secret is a runtime variable.
- `NEXT_OUTPUT=standalone` is set by the Dockerfile only. Without it `next.config.ts` produces exactly the configuration Vercel builds (`next.config.test.ts`).
- Base image: `node:22-bookworm-slim`, pinned by the digest of its multi-arch index (linux/amd64 and linux/arm64). To refresh, run `docker buildx imagetools inspect node:22-bookworm-slim`, check both platforms are listed, and copy the top `Digest:` into the `NODE_IMAGE` default of the Dockerfile.
- Build egress: the npm registry, Debian's package mirror (`openssl`, `ca-certificates`) and `binaries.prisma.sh` (the `npm ci` postinstall of `@prisma/engines` downloads the migration engine for the build platform).
- The image runs as `node` (uid 1000). Application files belong to root and are read-only for the app; only `.next/cache` is writable. No `.env` file is copied into any stage (`.dockerignore` excludes them).

## Run

| | |
|---|---|
| Port | `3000` (`PORT`), on `0.0.0.0` (`HOSTNAME`, set in the image) |
| Command | `node server.js` (Next's standalone server) |
| Liveness | `GET /api/health`: 200 `{"ok":true}`, no database |
| Readiness | `GET /api/health/ready`: 200 when the database answers `SELECT 1` within 2 s, 503 otherwise. Use this one for the runner's `health.path` |
| Stop | `SIGTERM`: Next stops accepting connections, finishes in-flight requests and pending `after()` callbacks, then exits with 143 |
| User | `node` (uid 1000) |

Both health paths answer on any `Host` (the proxy does not classify the host for them).

**`after()` and shutdown.** Eight places schedule work after the response with Next's `after()`: the Citizen Pay pushes (`services/citizenpay/after-response.ts`: top-up URL, events webhook, treasury kind), `services/citizenpay/token-roles.ts`, the card holder syncs (`services/card/holder-sync.ts`, three), `services/card/publish-holder-name.ts`, `services/token-account/publish-name.ts` and the subscription emails (`services/fund-setup/admin-actions.ts`). Under the standalone server they run after the response is sent, and a `SIGTERM` waits for them: checked by accepting a subscription with a fake mail API that answers after 8 s and stopping the container right after the response; the email went out, the next log line was written, and the process exited (143) 8.2 s after the signal. An idle container stops in about 0.3 s. Give the runner's `drain` room for the slowest of these: Citizen Pay calls time out after 15 s at most (3 s for the settings pushes), an email send has no timeout of its own. The default 30 s covers the usual case; a callback still running when `drain` ends is cut by `SIGKILL`, as on Vercel when a function times out.

### Release command

The runner runs one of these in a one-off container from the new image, with the deployment's environment, before the new version takes traffic:

| | argv |
|---|---|
| Migrations only | `["node", "release/release.mjs"]` |
| Migrations, then the synthetic seed (staging) | `["node", "release/release.mjs", "--seed"]` |

Exit 0 on success. Non-zero aborts the deploy. `prisma migrate deploy` uses `DIRECT_URL` when set, else `DATABASE_URL`.

The seed refuses (exit 2, nothing written) unless `SEED_SYNTHETIC_OK=1`, and on a database holding any fund it did not create (seeded funds have fixed ids). It is idempotent: a second run writes nothing new. So once someone creates a fund on staging by hand, the seed argv fails every deploy: switch the runner to the migrations-only argv at that point.

What the seed creates: three funds (`alpha.lacaisse.eu` and `beta.lacaisse.eu`, served at `alpha.<APP_DOMAIN>` and `beta.<APP_DOMAIN>`, and `caisse-gamma.example.org` as a custom domain value; alpha has member login on; beta's hosting subscription is left to accept, the others are waived), an OWNER and an OPERATOR per fund (`owner.alpha@example.org`, `operator.alpha@example.org`, and so on), a platform admin (`platform-admin@example.org`), members with cards, spare cards, tiers and merchants. All names say "Synthetic" or "Test"; all addresses are under `example.org`. Each fund gets a fake Citizen Pay treasury id (so the crons pick it up in mock mode) and, when `APP_CRED_KEY` is set, two encrypted cells (a fake API key and a freshly generated minter key that holds nothing), so a key rotation has something to re-encrypt.

### Database TLS

`DATABASE_CA_CERT` (the PEM of the CA that signed the database's certificate) turns on TLS with full verification for every connection: the app's Prisma client (`services/db/tls.ts`), the migration engine and the seed. The chain must lead to that CA and the certificate must name the host of the URL (a DNS name or an IP address SAN). The URL's own `sslmode` and related parameters are replaced. A PEM flattened to one line with literal `\n` is accepted. Without `DATABASE_CA_CERT`, the URL is used as is, exactly as on Vercel.

Prisma's migration engine takes the CA as a file, so `release.mjs` writes it to a fresh private temporary directory (0700, file 0600), passes `sslmode=require&sslcert=<file>&sslaccept=strict` to the engine, and removes the directory when the migration ends. The engine on macOS cannot speak TLS 1.3; inside the image (Linux, OpenSSL 3) it can.

Good to know: without `sslaccept=strict`, Prisma's migration engine does not verify the server certificate at all, whatever `sslmode` says (`sslmode=verify-full` with a certificate from an unknown CA connects). That is why the CA path sets it. Without `DATABASE_CA_CERT` nothing changes, so migrations against Supabase behave as they always have.

### Behind the runner's edge

The app expects the edge to pass the original host: `Host` (and `X-Forwarded-Host`) = the name the browser asked for, `X-Forwarded-Proto: https`, `X-Forwarded-For` = the client address (the per-IP attempt limiters read its first entry). The connection from the edge is plain HTTP.

Host handling does not depend on the scheme the request arrived with. `proxy.ts` classifies the host against `APP_DOMAIN`; absolute URLs (auth host, fund URLs, redirects, emails, Better Auth's base URL and trusted origins, the passkey RP ID) are built from `APP_DOMAIN` and `https` whenever `NODE_ENV=production` (always in the image). Session cookies stay host-only. A two-level `APP_DOMAIN` works: `acme.staging.lacaisse.eu` is the fund stored as `acme.lacaisse.eu`, and `a.b.staging.lacaisse.eu` is no fund.

### Platform endpoints

Both are guarded exactly like the cron routes: `Authorization: Bearer <CRON_SECRET>`, 401 on a wrong or missing bearer, 503 when `CRON_SECRET` is unset.

**`GET /api/internal/hostname-allowed?hostname=<lowercase fqdn>`** (on-demand TLS). 200 for `APP_DOMAIN`, `auth.<APP_DOMAIN>`, `<sub>.<APP_DOMAIN>` of an existing fund, and a registered custom `Fund.domain`. 404 for anything else, including reserved subdomains (`www`, `api`, `admin`, `app`), deeper names, and `*.lacaisse.eu` names on a non-production apex. 400 on missing, repeated or malformed input (upper case, a port, a trailing dot). Empty bodies. One unique-index lookup on `Fund.domain`, never a listing.

**`POST /api/maintenance/reencrypt-app-cred`** (APP_CRED_KEY rotation, built on `scripts/lib/app-cred-rotation*.ts`, the same code as `scripts/rotate-app-cred-key.ts`). With `APP_CRED_KEY=<new>` and `APP_CRED_KEY_PREVIOUS=<old>` in the environment, each call re-encrypts at most 50 cells sealed under the previous key, in one transaction, and answers 200 `{"done": <bool>, "reencrypted": <int>, "remaining": <int>}`. Call it until `done` is true; a call after that is a no-op (`{"done":true,"reencrypted":0,"remaining":0}`). Other answers mean "not done, read the app's log": 409 when a cell opens with neither key (nothing is written) or changed during the write (rolled back, call again), 500 when a key is malformed.

### Crons

The ten routes of `vercel.json`, with the same schedules (UTC). Each is a `GET` with `Authorization: Bearer <CRON_SECRET>`. In the image (`DEPLOY_TARGET=container`) the routes run for real and require the bearer; on Vercel nothing changed. They do not depend on `Host`; the runner's `Host: <first domain>` (the apex) is fine. `payment-reminders` sends its emails one after the other inside the request: give it a generous `timeout`.

```yaml
crons:
  - { name: auth-exchange-cleanup,       schedule: "0 3 * * *",    path: /api/cron/auth-exchange-cleanup,       bearer: CRON_SECRET }
  - { name: citizenpay-operation-status, schedule: "*/5 * * * *",  path: /api/cron/citizenpay-operation-status, bearer: CRON_SECRET }
  - { name: citizenpay-bank-sync,        schedule: "*/15 * * * *", path: /api/cron/citizenpay-bank-sync,        bearer: CRON_SECRET }
  - { name: citizenpay-period-close,     schedule: "*/30 * * * *", path: /api/cron/citizenpay-period-close,     bearer: CRON_SECRET }
  - { name: citizenpay-mint-retry,       schedule: "*/10 * * * *", path: /api/cron/citizenpay-mint-retry,       bearer: CRON_SECRET }
  - { name: annotation-resolve,          schedule: "*/2 * * * *",  path: /api/cron/annotation-resolve,          bearer: CRON_SECRET }
  - { name: payment-reminders,           schedule: "0 6 1 * *",    path: /api/cron/payment-reminders,           bearer: CRON_SECRET }
  - { name: topups,                      schedule: "* * * * *",    path: /api/cron/topups,                      bearer: CRON_SECRET }
  - { name: safe-sync,                   schedule: "*/2 * * * *",  path: /api/cron/safe-sync,                   bearer: CRON_SECRET }
  - { name: conversions,                 schedule: "*/2 * * * *",  path: /api/cron/conversions,               bearer: CRON_SECRET }
```

## Environment

Set by the image (do not put them in a bundle): `NODE_ENV=production`, `HOSTNAME=0.0.0.0`, `PORT=3000`, `DEPLOY_TARGET=container`, `NEXT_TELEMETRY_DISABLED=1`.

"Secret" = goes in the lockbox bundle and nowhere else.

| Variable | Required | Secret | What |
|---|---|---|---|
| `DATABASE_URL` | yes | yes | Postgres URL for the app (and the release command when `DIRECT_URL` is unset) |
| `DIRECT_URL` | no | yes | Postgres URL for migrations only (Supabase's session pooler on Vercel); leave unset with a direct database |
| `DATABASE_CA_CERT` | no | no | PEM of the database's CA; turns on verified TLS (above) |
| `APP_DOMAIN` | yes | no | the apex, e.g. `staging.lacaisse.eu` |
| `BETTER_AUTH_SECRET` | yes | yes | signs sessions and encrypts the OAuth signing keys |
| `APP_CRED_KEY` | yes | yes | 64 hex chars; encrypts secrets stored in rows, signs unsubscribe links |
| `APP_CRED_KEY_PREVIOUS` | no | yes | only during a key rotation |
| `CRON_SECRET` | yes | yes | bearer of the crons and of the two platform endpoints |
| `CITIZENPAY_API_BASE_URL` | no | no | unset = in-process Citizen Pay mock |
| `CITIZENPAY_BUNDLER_URL` | no | no | 4337 bundler for mint and burn |
| `CITIZENPAY_DASHBOARD_URL` | no | no | default `https://my.citizenpay.xyz` |
| `CITIZENPAY_MERCHANT_ONBOARDING_URL` | no | no | link in the merchant approval email |
| `CITIZENPAY_REGISTER_CHAIN` | no | no | chain prefix for treasury registration, default `100` |
| `CITIZENPAY_TAP_BASE_URL` | no | no | wallet links in emails, default `https://tap.citizenpay.xyz` |
| `CITIZENPAY_API_AUDIENCE` | no | no | member login: the api's URL as token audience |
| `WALLET_OAUTH_CLIENT_SECRET` | no | yes | member login: the wallet's OAuth client secret |
| `WALLET_OAUTH_REDIRECT_URIS` | no | no | member login: replaces the default redirect URIs |
| `RESEND_API_KEY` | no | yes | unset = no email leaves (every send fails with a logged error) |
| `EMAIL_FROM` | no | no | sender address, needed with `RESEND_API_KEY` |
| `PLATFORM_BILLING_EMAIL` | no | no | where subscription notices go; unset = logged only |
| `ALCHEMY_API_KEY` | no | yes | Gnosis RPC and token reads |
| `SAFE_RELAYER_PRIVATE_KEY` | no | yes | Safe relayer; unset = Safe actions report "relayer not configured" |
| `SAFE_API_KEY` | no | yes | Safe Transaction Service |
| `SAFE_TX_SERVICE_URL` | no | no | override of the Transaction Service base |
| `COW_API_URL` | no | no | override of the CoW orderbook base |
| `GIT_COMMIT_SHA` | no | no | commit shown by the source link (Vercel uses `VERCEL_GIT_COMMIT_SHA`) |
| `SEED_SYNTHETIC_OK` | seed only | no | must be `1` for `--seed` |
| `SEED_STAFF_PASSWORD` | no | yes | password of the seeded staff accounts; unset = they have none |
| `CRON_ALLOW_NONPROD` | no | no | not needed in the image |

**Staging leaves unset:** `CITIZENPAY_API_BASE_URL` (Citizen Pay mock mode), `RESEND_API_KEY` and `EMAIL_FROM` (email disabled), `CITIZENPAY_BUNDLER_URL`, `ALCHEMY_API_KEY`, `SAFE_RELAYER_PRIVATE_KEY`, `SAFE_API_KEY`, `WALLET_OAUTH_CLIENT_SECRET`, `CITIZENPAY_API_AUDIENCE`, `PLATFORM_BILLING_EMAIL`, `DIRECT_URL`. It sets `SEED_SYNTHETIC_OK=1` while it uses the seed argv.

## Local run

```sh
docker build -t lacaisse-webapp .
docker network create lc
docker run -d --name lc-db --network lc -e POSTGRES_PASSWORD=<generated> -e POSTGRES_DB=lacaisse postgres:17
# env file outside the repository: DATABASE_URL, APP_DOMAIN=staging.lacaisse.eu,
# BETTER_AUTH_SECRET, APP_CRED_KEY, CRON_SECRET (fresh random values), SEED_SYNTHETIC_OK=1
docker run --rm --network lc --env-file <file> lacaisse-webapp node release/release.mjs --seed
docker run -d --name lc-web --network lc -p 127.0.0.1:3000:3000 --env-file <file> lacaisse-webapp
curl -H 'Host: alpha.staging.lacaisse.eu' -H 'X-Forwarded-Proto: https' http://127.0.0.1:3000/
```

The image always builds `https://` URLs without a port (`NODE_ENV=production`), so a browser on `localhost` follows redirects to hosts it cannot reach. Use `curl` with a `Host` header, or a local proxy that answers for those names.
