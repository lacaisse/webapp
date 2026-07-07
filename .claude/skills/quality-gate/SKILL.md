---
name: quality-gate
description: Pre-ship verification for this repo — run the mechanical checks (guard, lint, typecheck, tests, i18n parity) and walk the convention checklist that machines can't catch. Use this before every commit or PR, whenever the user asks if the work is "done", "ready", "clean", or wants a review of the current changes, and after finishing any multi-file feature — even when nobody explicitly asks for checks.
---

# Quality gate

Run this before declaring any change done. It has two halves: commands that give a hard pass/fail, and a short judgment checklist for the conventions no script can see. Report failures with their actual output — never summarize a red check as "mostly passing".

## 1. Mechanical checks (run all; they're independent, run in parallel)

```bash
npm run guard      # architectural invariants: no DB/env in client, "use server" export rules
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run test       # vitest run
node .claude/skills/quality-gate/scripts/check-i18n-parity.mjs  # all locales have identical key sets
```

Notes:
- `typecheck` needs the generated Prisma client; if it errors on `services/db/generated`, run `npx prisma generate` first.
- The i18n script matters because next-intl fails at runtime, not build time: a key added only to `fr.json` renders as a raw key string for every other locale. Default locale is `fr`; `messages/` currently has fr, en, es, nl.
- Tests are co-located `*.test.ts` in `services/`. If you added pure domain logic (calculations, parsing, eligibility rules) without a test, that's a gap — this repo unit-tests that layer (see `services/member/contribution.test.ts`).

## 2. Judgment checklist (read the diff with these in mind)

Structure and tenancy have their own skills — apply **feature-structure** if files were added or moved, and **tenant-safety** if anything touches fund-scoped data. Then check what's left:

- **SPDX header**: every new source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- **i18n completeness**: no hardcoded user-facing strings in JSX or action return values; new keys added to *all* locale files with real translations, not the English text pasted four times. Zod error messages are keys, resolved via `t(issue.message as never)`.
- **Destructive actions confirmed**: delete/archive/irreversible mutations go through an in-app confirmation dialog (never `confirm()`), and the server action itself re-checks authorization — the dialog is UX, not security.
- **Server-first data**: initial page data loads in the server component with `<Suspense>` + skeleton fallbacks; no client-side fetch for what the server could render. Navigation state (tab, page, search) is in URL params, back/forward must work.
- **Action return shape**: `{ ok: true } | { error: string, field? }`, translated errors, `revalidatePath` after UI-visible writes, `redirect()` only on success-navigation. `refresh()` from `next/cache` only inside server actions — from client code use `useRouter().refresh()`.
- **base-nova, not Radix**: no `asChild`, no RHF `<Form>` component; `buttonVariants()` for link-buttons, `render` prop for triggers. If a snippet came from Radix-flavored shadcn docs, it's probably wrong here.
- **Migrations**: if `prisma/schema.prisma` changed, a migration exists (`npx prisma migrate dev --name <change>`) and new columns on fund-owned models include `fundId` with an index where queried. Secret-bearing columns end in `*Enc` and go through `services/crypto/secret.ts`.
- **No scope creep in "use server" files**: only async function exports (guard catches most, but re-exports slip through).

## 3. Reporting

Summarize as a short verdict: which commands ran, pass/fail each, then any checklist findings ranked by severity (tenant/authz issues first — they're leaks, not nits). If everything passes, say so plainly and stop; don't invent findings to seem thorough.
