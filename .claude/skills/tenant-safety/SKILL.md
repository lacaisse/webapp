---
name: tenant-safety
description: Multi-tenant data-isolation and multi-domain review for this fund-per-domain app. Use this whenever you write or review ANY code that touches Prisma queries, server actions, API routes, cron jobs, redirects, or URLs — even if tenancy isn't mentioned — and always before committing changes that read or mutate fund-scoped data. A missing fundId filter here is a cross-tenant data leak, not a style nit.
---

# Tenant safety

Each fund (French: "caisse") is a tenant, and **the host is the tenant identity**: `proxy.ts` resolves `Fund.findUnique({ where: { domain: host } })` once per request and forwards `x-fund-domain` / `x-fund-id` / `x-host-type` headers (stripping any inbound spoofed copies). Almost every table hangs off `Fund` via a `fundId` column. The threat model for every change is: *could a request on fund A's domain, or a crafted input, ever read or mutate fund B's rows?*

Walk this checklist over the diff. Each item is a bug class that has to be caught in review because no lint rule can see it.

## 1. Every query is fund-scoped

- Any Prisma query on a fund-owned model must carry `fundId: fund.id` in its `where` — including `count`, `aggregate`, `updateMany`, `deleteMany`, and nested reads.
- **The classic leak**: `findUnique({ where: { id: input.id } })` with a client-supplied id. A row id is not proof of ownership — an attacker can paste any UUID. Fetch with `findFirst({ where: { id: input.id, fundId: fund.id } })` or scope the mutation itself (`deleteMany({ where: { id, fundId } })` and check `count`), as `revokeFundInviteAction` in `services/fund-team/admin-actions.ts` does.
- `findUnique` by plain id is only OK when the id **came from a query you already scoped** in the same function, or the model is genuinely global (User, Fund itself).
- Unique lookups by natural key (token, email, serial) still need the fund in the compound: `where: { fundId: fund.id, token }`, never token alone — tokens from one fund must not open doors on another.

## 2. Authorization comes from the DAL, never from input

- The fund comes from the host: `requireCurrentFund()` / `requireFundRole(minRole)` from `services/auth/dal.ts`. **Never accept a fundId, domain, or role from client input** — if an action takes one, that's the finding.
- Role tiers: `requireAdmin()` = platform staff; `requireFundRole("OWNER" | "ADMIN" | "OPERATOR" | "VIEWER")` = per-fund. OPERATOR is restricted to card + member management; money movement (top-up/withdraw/mint/burn) stays ADMIN+. New actions must pick the tier deliberately — match what sibling actions in the same service use, and gate at the **action**, not just the page (pages hide links; actions are the trust boundary).
- Cross-role writes need their own rules — see the OWNER guardrails in `changeFundMemberRoleAction` (can't grant above your rank, can't demote the last OWNER). New privilege-affecting actions need equivalents.

## 3. Multi-domain / host handling

- Never re-parse the `Host` header. Read host context only via `services/host/server.ts` (`getHostType`, `getAuthUrl`) and `services/fund/server.ts` (`getCurrentFund*`, `requireCurrentFund`, `getFundUrl`, `getApexUrl`).
- `redirect("/path")` stays on the current host. Crossing hosts (fund → apex, anything → auth host) needs the absolute-URL helpers. Links in emails must be absolute fund URLs via `getFundUrl(fund.domain)`.
- Don't touch the ordering inside `proxy.ts` — the header stripping and the auth `getSession` refresh are load-bearing.

## 4. Public and unauthenticated surfaces

- Anything in `app/(fund-public)/` or a public route handler runs without a session. Its capability must be bounded by an unguessable token (invite token, pay-link reference) **checked against the current fund**, with expiry/single-use where applicable — see `acceptFundInviteAction` (fund match + expiry + email match).
- Cron routes (`app/api/cron/*`) run with no fund context; they must iterate funds explicitly and keep every per-fund operation scoped inside the loop. A cron that resolves "the" fund is wrong by construction.
- Redirect-callback routes (e.g. the CitizenPay callback) are public by design; their auth is the single-use state row. Keep that pattern — don't add session requirements that break mid-redirect flows, and don't weaken the single-use/TTL checks.

## 5. Per-fund secrets and money paths

- Credentials are per-fund, encrypted with `services/crypto/secret.ts` (`*Enc` columns) — the **only** AES path. External clients are built per fund (`getCitizenPayClient(fund)`); never cache one fund's client or key where another fund's request can reach it (module-level singletons keyed by nothing are the failure mode).
- Anything minting, burning, charging, or transferring value gets extra scrutiny: ADMIN+ gate, amount validated server-side, operation recorded (e.g. `TokenOperation` row), idempotency where a retry could double-spend (see the `idempotencyKey` on email sends and `(fundId, externalId)` upserts in bank-sync).

## How to review with this

For each changed file: identify the actor (who can call this?), the tenant source (where does `fund` come from?), then read every Prisma call and ask "which fund's rows can this touch?". Grep is your friend — `deleteMany(`, `updateMany(`, `findUnique(` in the diff are the highest-yield lines to inspect. Report violations with the concrete cross-tenant scenario, not just the rule name.
