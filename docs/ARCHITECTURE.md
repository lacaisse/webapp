<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Architecture

A developer's guide to how La Caisse is built and where things live. For the
product overview see the [README](../README.md); for day-to-day conventions and
framework gotchas see [AGENTS.md](../AGENTS.md); for visual tokens see
[design-system.md](./design-system.md).

> **What this app is.** La Caisse is a multi-tenant admin dashboard for running
> local solidarity food funds (a _fund_ in code, a _caisse_ in French). Each
> fund manages **members** (the people it supports), the **cards** they spend
> with, the on-chain **token** that funds those cards, and the **merchants**
> where the token is spent. Money flows in as bank deposits and gets converted
> into spendable token balances; staff oversee the whole cycle from this
> dashboard. One deployment serves many funds, each on its own hostname and
> brand.

---

## 1. The big picture

```
                       ┌──────────────────────────────────────────────┐
   Browser  ──────────▶│  proxy.ts  (Next 16 middleware)               │
   any *.lacaisse.eu   │  • classifies host → auth | apex | fund       │
                       │  • looks up Fund by domain, injects headers    │
                       └───────────────┬──────────────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                         ▼
        Server Components        Server Actions             Route Handlers
        (read via services)      ("use server", writes)     (app/api/*, crons)
              │                        │                         │
              └────────────────────────┴─────────────┬───────────┘
                                                      ▼
                                            services/  (all I/O)
                          ┌──────────┬──────────┬──────────┬──────────┐
                          ▼          ▼          ▼          ▼          ▼
                       Prisma     Better      Resend    CitizenPay   Alchemy
                       (Postgres)  Auth       (email)   (banking +   (on-chain
                                                         bundler)     reads)
```

The hard rule: **components and client code never touch a database, secret, or
external API directly.** All of that lives behind `services/`, reached from
Server Components (reads) and Server Actions (writes). This keeps trust and
secrets on the server. See [AGENTS.md → Data access](../AGENTS.md).

---

## 2. Multi-tenancy: the host *is* the fund

There is no "slug" or tenant-id query param. A fund's identity is its full
hostname, stored in `Fund.domain`:

- Free funds: `acme.lacaisse.eu`
- Paid custom domains: `funds.acme.com`
- Dev: `acme.localhost:3000` (browsers resolve `*.localhost` to 127.0.0.1 — no
  `/etc/hosts` edits needed)

[`proxy.ts`](../proxy.ts) runs on every request and:

1. Classifies the host into one of three **host types** (`services/host/server.ts`):
   - **`auth`** — the dedicated auth host (login/signup/password reset live here)
   - **`apex`** — the bare app domain (fund picker, create-fund, account settings)
   - **`fund`** — a fund subdomain or custom domain
2. For a `fund` host, does exactly one DB lookup: `Fund.findUnique({ where: { domain: host } })`.
3. Strips any inbound `x-fund-domain` / `x-fund-id` headers (so a client can't
   spoof fund context), then sets them from the lookup on success.

App code **never re-parses the host.** It reads the current fund through
`services/fund/server.ts` (`getCurrentFund`, `requireCurrentFund`,
`getFundUrl`, `getApexUrl`) and the host type through `services/host/server.ts`.

---

## 3. Authentication & authorization

> ⚠️ **Auth is [Better Auth](https://better-auth.com), not Supabase Auth.** Some
> older notes (and parts of AGENTS.md) still describe a Supabase-Auth design;
> the shipped code uses `better-auth` + `@better-auth/passkey` with Prisma as the
> store. There is no Supabase dependency. This document reflects the code.

### Sessions
Better Auth owns the `User`, `Session`, `Account`, `Verification`, and `Passkey`
tables directly (Prisma store). The mounted handler is
`app/api/auth/[...all]/route.ts`; configuration is in
`services/auth/better-auth.ts`; the browser client is `services/auth/client.ts`.

### The DAL
[`services/auth/dal.ts`](../services/auth/dal.ts) is the single entry point for
"who is this and what may they do." Every function is wrapped in React's
`cache()` so a render pass hits the session/DB once:

| Function | Use |
| --- | --- |
| `getCurrentUser()` | The Prisma `User` or `null`. |
| `requireUser()` | Redirects to login (with cross-host `return_to`) if anonymous. |
| `requireAdmin()` | Requires platform `globalRole === "ADMIN"`. |
| `requireFundRole(minRole)` | Requires fund membership ≥ `minRole`; returns `{ user, fund, membership }`. |

### Two role systems
- **`User.globalRole`** — `USER` | `ADMIN`. Platform-wide. Set via SQL/admin
  tooling; gates cross-fund operations.
- **`FundMember.role`** — `OWNER` > `ADMIN` > `VIEWER` (ranked in the DAL).
  Per-fund staff access. This is what `requireFundRole()` checks.

> Note: `FundMember.role` has **three** levels (`OWNER`, `ADMIN`, `VIEWER`) —
> there is no `MEMBER` staff role. A fund's _members_ (the people it supports)
> are a separate `Member` model entirely (see §5), not staff.

### Cross-host session bridge
Because login happens on the `auth` host but the user works on a `fund` host,
sessions are handed across origins with a short-lived single-use code: the auth
host mints an `AuthExchange` row, redirects to the target host's
`/auth/exchange?code=…`, which consumes it and writes the session cookies. See
`services/auth/exchange.ts` and `services/auth/redirects.ts`. Expired codes are
swept nightly by the `auth-exchange-cleanup` cron.

### Passkeys
WebAuthn via `@better-auth/passkey`. `rpID` is the apex domain, so a passkey
registered on one fund subdomain works across all of them. Managed at
`/(apex)/account/passkeys`.

---

## 4. Directory map

```
app/
  (auth-host)/        login, signup, forgot-/reset-password — the auth host UI
  (apex)/             fund picker context: /new (create fund), /account/passkeys
  (fund)/             protected staff dashboard (see route table below)
  (fund-public)/      unauthenticated per-fund flows: /join, /join-merchant,
                      /verify-email, citizenpay invite landing
  api/
    auth/[...all]/    Better Auth handler
    citizenpay/       connect, callback/[fundState], invite-callback
    cron/             5 Vercel cron handlers (see §7)
  auth/               cross-host exchange + logout route handlers
  _landing/ _policy/  marketing + legal page fragments
  privacy/ terms/ source/ licenses/   static-ish pages
  layout.tsx page.tsx not-found.tsx    root shell + apex/fund dispatch

services/             ALL data access & external I/O (see §6)
components/           shared UI; components/ui/ = shadcn base-nova primitives
prisma/               schema.prisma + migrations/
messages/             next-intl catalogs: fr.json (default), en.json, …
i18n/                 next-intl request config
docs/                 this file + design system + treasury integration notes
scripts/              license generation, secret-encryption CLI helper
proxy.ts              Next 16 middleware (host routing)
prisma.config.ts      Prisma 7 CLI config (loads .env, splits DIRECT/DATABASE URL)
vercel.json           cron schedules
```

### Staff dashboard routes — `app/(fund)/`

| Route | What it does |
| --- | --- |
| `/dashboard` | Fund overview & key stats. |
| `/members`, `/members/[id]` | Member roster; detail with status, tier, cards. |
| `/cards`, `/cards/[id]` | Card inventory; detail, history, manual top-up/withdraw. |
| `/merchants`, `/merchants/[id]` | Merchant directory + approval workflow; CitizenPay place linking. |
| `/token` | On-chain explorer: holders, transfers, supply (read via Alchemy). |
| `/allocations`, `/allocations/periods/[id]` | Allocation tiers; FIXED_PERIOD windows + minting status. |
| `/payments` | Bank transactions and their member/merchant matching. |
| `/referrals` | Referral programme stats. |
| `/emails` | Transactional email log + detail. |
| `/settings` | Branding, legal, token (read-only), CitizenPay connect, onboarding fields, referrals. |

---

## 5. Domain model

The Prisma schema (`prisma/schema.prisma`) is the source of truth. The core
graph:

```
User ──< FundMember >── Fund ──┬─< Member ──< Card
                               ├─< Merchant
                               ├─< AllocationTier
                               ├─< AllocationPeriod
                               ├─< BankTransaction
                               ├─< TokenOperation
                               ├─< Referral
                               └─< Email / OnboardingField / EmailVerification
```

| Model | Role | Lifecycle / notes |
| --- | --- | --- |
| **User** | Auth identity (Better Auth). | `globalRole` USER/ADMIN. `id` is a uuid. |
| **FundMember** | Staff membership. | `role` OWNER/ADMIN/VIEWER, unique per `(userId, fundId)`. |
| **Fund** | The tenant ("caisse"). | `domain` = identity. Caches token + CitizenPay config. |
| **Member** | A supported person. | `INVITED → ONBOARDING → ACTIVE → INACTIVE/LEFT`. Has `paymentReference`, `referralCode`, optional `tierId`. |
| **Card** | Spend instrument. | `serialNumber` (NFC), `account` (on-chain addr), `status` ACTIVE/INACTIVE/BLOCKED. |
| **AllocationTier** | Contribution band → allocation amount. | Soft-deleted via `archivedAt`. Position-ordered. |
| **AllocationPeriod** | A funding window (FIXED_PERIOD mode). | `OPEN → IN_PROGRESS → CLOSED`. |
| **BankTransaction** | Local mirror of a CitizenPay bank movement. | `direction` IN/OUT; links to member/merchant; sources token mints. |
| **TokenOperation** | Audit record of a mint/burn/transfer. | `PENDING → CONFIRMED/FAILED`, carries `txHash`. |
| **TokenOperationSource** | Join: which bank txns funded which operation. | Carries `attributedAmount`. |
| **Referral** | Sponsor→referee link. | `PENDING → ACTIVATED`; activation grants the sponsor a reward `TokenOperation`. |
| **Email** | Transactional outbox/audit. | Typed (reminders, confirmations, …) with `idempotencyKey`. |
| **Merchant** | Shop accepting the token. | `PENDING → ACTIVE / REJECTED / INACTIVE`; linked to a CitizenPay place. |
| **OnboardingField** | Per-fund extra signup fields. | Targets MEMBER or MERCHANT; typed; soft-deleted. |
| **AuthExchange** | Cross-host session handoff code. | Single-use, short TTL, cron-swept. |
| **CitizenPayConnectAttempt** | API-key handoff state (CSRF). | Single-use, 30-min TTL, cron-swept. |
| **EmailVerification** | Email-confirm token for member/merchant signup. | Single-use, TTL. |
| **AddressProfileCache** | Cached on-chain address → name resolution. | TTL (hit/miss). |

### Allocation modes
A fund runs in one of two `AllocationMode`s:
- **FIXED_PERIOD** — deposits accumulate against an open `AllocationPeriod`; the
  `citizenpay-period-close` cron batch-mints allocations at the cutoff.
- **PAY_AND_GO** — a detected deposit is converted to token immediately.

---

## 6. Services layer

Every external boundary has its own module so it's swappable and individually
testable.

| Folder | Responsibility |
| --- | --- |
| `db/` | Prisma client (`prisma.ts`, driver-adapter wired) + generated client under `db/generated/`. |
| `auth/` | Better Auth config, browser client, the **DAL**, cross-host exchange, redirects. |
| `host/` | Host classification + apex/auth/fund URL builders. |
| `fund/` | Fund read helpers (`server.ts`), create action, settings actions. |
| `member/` | Member signup + admin actions (activate, invite, tier, status). |
| `merchant/` | Merchant signup, approval workflow, CitizenPay place sync. |
| `card/` | Card admin actions (block, top-up, withdraw, import) + sync planning. |
| `allocation-tiers/`, `allocation-periods/` | Tier CRUD; period close/minting. |
| `bank-sync/` | Ingest CitizenPay deposits; link/unlink to members. |
| `token/`, `token-operations/` | Mint/burn via the CitizenPay bundler (4337 UserOps); operation audit, retry, recipient search. |
| `citizenpay/` | `api.ts` (OpenAPI-faithful wrapper) → `live-client.ts` (high-level) via `getCitizenPayClient(fund)`; `connect.ts` (key issuance), `sync.ts` (token info). |
| `alchemy/` | On-chain **reads** on Gnosis: balances, supply, transfers, formatting. |
| `email/` | Resend transport + typed transactional sends + verification emails. |
| `crypto/` | The only AES-256-GCM helper for secrets at rest (`*Enc` columns). |
| `i18n/` | Locale resolution + `setLocale` action (cookie-based, default `fr`). |
| `onboarding/` | Per-fund custom signup fields. |
| `profile/` | On-chain address → display-name resolver (with cache). |

**Mock vs live CitizenPay** is chosen by `CITIZENPAY_API_BASE_URL`: unset → an
in-process mock (good for local dev); set → live mode, and any fund missing
credentials throws (no silent fallback).

---

## 7. Background jobs (Vercel cron)

Schedules in [`vercel.json`](../vercel.json); handlers in `app/api/cron/*`. All
are authorized with `CRON_SECRET`.

| Cron | Schedule | Job |
| --- | --- | --- |
| `auth-exchange-cleanup` | daily 03:00 | Expire used/old `AuthExchange` + `CitizenPayConnectAttempt` rows. |
| `citizenpay-operation-status` | every 5 min | Poll on-chain status of pending `TokenOperation`s → CONFIRMED/FAILED. |
| `citizenpay-mint-retry` | every 10 min | Retry failed mints. |
| `citizenpay-bank-sync` | every 15 min | Pull deposits, mirror to `BankTransaction`, match members, mint (PAY_AND_GO). |
| `citizenpay-period-close` | every 30 min | Batch-mint allocations for periods past cutoff (FIXED_PERIOD). |

---

## 8. Key end-to-end flows

### Member onboarding → first allocation
1. A prospective member submits `/(fund-public)/join` → `signupMemberAction`
   creates a `Member` (`INVITED`/`ONBOARDING`) with a unique `paymentReference`.
   Optional email verification via `EmailVerification`.
2. Staff activate the member and assign an `AllocationTier`
   (`/members/[id]` → tier/status actions).
3. The member transfers money to the fund's bank account citing their
   `paymentReference`.
4. `citizenpay-bank-sync` detects the deposit, creates a `BankTransaction`, and
   matches it to the member by reference.
5. Depending on `AllocationMode`, token is minted immediately (PAY_AND_GO) or at
   period close (FIXED_PERIOD). A `TokenOperation` records the mint and links to
   the funding `BankTransaction` via `TokenOperationSource`.
6. `citizenpay-operation-status` flips the operation to CONFIRMED once on-chain.
   The token is now spendable on the member's `Card`.

### Merchant onboarding
`/(fund-public)/join-merchant` → `signupMerchantAction` (status `PENDING`) →
staff review (`approve`/`reject`) → on approval the merchant is invited/linked to
a CitizenPay **place** so it can accept the token and receive payouts. See
[TREASURY_BUSINESS_INVITE.md](./TREASURY_BUSINESS_INVITE.md).

### Connecting a fund to CitizenPay
The treasury is created out-of-band on CitizenPay's side. An admin pastes the
`citizenPayFundId` into settings, then `/api/citizenpay/connect` redirects to CP
to mint an API key. CP redirects back to
`/api/citizenpay/callback/[fundState]`, which stores the (encrypted) key and
fetches token metadata. The fund-state path segment is the CSRF guard. Details &
rationale in [AGENTS.md → CitizenPay API-key handoff](../AGENTS.md) and
[TREASURY_DASHBOARD_CONNECTIONS.md](./TREASURY_DASHBOARD_CONNECTIONS.md).

---

## 9. Environment variables

From [`.env.example`](../.env.example):

| Variable | Concern |
| --- | --- |
| `APP_DOMAIN` / `NEXT_PUBLIC_APP_DOMAIN` | Apex domain (server / client-visible mirror). |
| `DATABASE_URL` | Pooled Postgres (Supavisor, txn mode, :6543) — runtime PrismaClient. |
| `DIRECT_URL` | Direct Postgres (:5432) — Prisma CLI migrations/studio. |
| `BETTER_AUTH_SECRET` | Better Auth session signing key. |
| `APP_CRED_KEY` | AES-256-GCM key for `*Enc` secret columns (32 bytes / 64 hex). |
| `CRON_SECRET` | Authorizes Vercel cron requests. |
| `RESEND_API_KEY` / `EMAIL_FROM` | Transactional email. |
| `CITIZENPAY_API_BASE_URL` | Treasury API root (unset ⇒ mock mode). |
| `CITIZENPAY_BUNDLER_URL` | 4337 bundler/paymaster for token mint/burn. |
| `CITIZENPAY_MERCHANT_ONBOARDING_URL` | Redirect target after merchant approval. |
| `ALCHEMY_API_KEY` | On-chain reads (Gnosis RPC + Token/Transfers APIs). |

> Per-fund CitizenPay credentials are **not** env vars — they live (encrypted)
> on the `Fund` row.

---

## 10. Where to read next

- [AGENTS.md](../AGENTS.md) — conventions and the non-obvious framework gotchas
  (Next 16 `proxy.ts`/async `cookies()`, Prisma 7 driver adapter & generated
  client, `"use server"` export rules, base-nova ≠ Radix, secret encryption,
  CitizenPay handoff). **Read before writing code.**
- [docs/design-system.md](./design-system.md) — colors, type, spacing tokens.
- [docs/TREASURY_BUSINESS_INVITE.md](./TREASURY_BUSINESS_INVITE.md) &
  [docs/TREASURY_DASHBOARD_CONNECTIONS.md](./TREASURY_DASHBOARD_CONNECTIONS.md) —
  CitizenPay integration specifics.
