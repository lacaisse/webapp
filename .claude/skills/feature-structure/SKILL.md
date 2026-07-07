---
name: feature-structure
description: Where code goes in this repo and how to scaffold it — service folders, app route groups, server actions, Zod schemas, forms, pages. Use this whenever you add a new feature, page, server action, service module, dialog, cron job, or file to this codebase, whenever you're unsure where something belongs, and when reviewing a diff for structural drift. Even a "small" new file should follow this layout.
---

# Feature structure

This repo has one architecture: **UI in `app/`, logic in `services/`, one folder per domain concept.** Every feature that has ever been merged follows it, so a new feature that doesn't will stick out in review and rot fast. When in doubt, find the closest existing domain folder and mirror it.

The code is the source of truth, not AGENTS.md — where they disagree (e.g. auth is **Better Auth** now, not Supabase), trust the code.

## The map

```
app/
  (apex)/         # pages on the apex domain (lacaisse.eu) — fund picker, account, create-fund
  (auth-host)/    # centralized login host (auth.lacaisse.eu)
  (fund)/         # admin dashboard pages, one fund per domain — gated by fund role
  (fund-public)/  # public pages on a fund domain (member pay page, invite accept…)
  api/            # route handlers: cron endpoints, webhooks, redirect callbacks only
services/<domain>/  # ALL database + external-service logic, one folder per concept
components/       # cross-page shared components; components/ui is shadcn base-nova
lib/              # pure utilities with no I/O (search parsing, cn, …)
messages/         # next-intl locale files: fr (default), en, es, nl — keep in sync
prisma/           # schema + migrations; generated client is services/db/generated (gitignored)
```

## Decision table

| You are adding… | It goes in… |
|---|---|
| A DB query or mutation | A server action or helper in `services/<domain>/` — never in a component, page, or route handler body |
| A user-triggered mutation | `services/<domain>/admin-actions.ts` (fund-admin gated) or `actions.ts` (member/public) — `"use server"` file |
| Validation / shared types for a form | `services/<domain>/schema.ts` — plain module, **no** `"use server"` |
| Non-action shared constants/config | `services/<domain>/config.ts` or `<topic>-config.ts` — same reason: `"use server"` files may only export async functions |
| Pure domain logic worth unit-testing | Its own file in the service folder with a co-located `*.test.ts` (vitest) — see `services/member/contribution.ts` + `.test.ts` |
| A dashboard page | `app/(fund)/<area>/page.tsx`, server component, data loaded server-side |
| Page-specific client components (dialogs, row actions) | Sibling files next to the `page.tsx` — see `app/(fund)/members/` |
| A new external service (API, email, chain) | Its own `services/<name>/` module so it can be swapped; secrets encrypted via `services/crypto/secret.ts`, columns named `*Enc` |
| A cron job | `app/api/cron/<name>/route.ts`, thin — real work in a service function |

New top-level domain concept → new `services/<domain>/` folder. Don't grow a grab-bag `utils` folder inside services.

## Canonical exemplars — read these before scaffolding

- **Smallest complete feature**: `services/fund-team/` (`schema.ts` + `admin-actions.ts`) with its UI under `app/(fund)/team/`. This is the pattern to copy.
- **Full list page** (tabs via query params, search, Suspense skeletons, dialogs): `app/(fund)/members/page.tsx` and its siblings.
- **Auth/gating primitives**: `services/auth/dal.ts` (`requireUser`, `requireAdmin`, `requireFundRole`), `services/fund/server.ts`, `services/host/server.ts`.

## The server-action pattern

Every mutation follows this shape (see `inviteFundMemberAction` in `services/fund-team/admin-actions.ts`):

1. File starts with the SPDX header (`// SPDX-License-Identifier: AGPL-3.0-or-later` — **every** source file in this repo has it), then `"use server"`.
2. `const t = await getTranslations()` — errors are returned as translated strings, keys live in the Zod schema (e.g. `"team.errors.emailInvalid"`), added to **all** `messages/*.json`.
3. Authorize **first**: `requireFundRole("ADMIN")` (or `"OPERATOR"` for card/member management, `requireUser()` for self-service, `requireAdmin()` for platform admin). Never accept a fundId from the client — the fund comes from the host via `requireCurrentFund()`.
4. Re-validate input with the same Zod schema the client used (`safeParse` — don't trust the client).
5. Do the work through `prisma` from `@/services/db/prisma`, multi-step writes in `prisma.$transaction`.
6. Return `{ ok: true }` / `{ error: string, field? }`, or call `redirect()` on success-with-navigation (it never returns). Finish UI-visible mutations with `revalidatePath("/<page>")`.

Forms: client component with `useForm` + `zodResolver` + `useTransition`, calling the action from `handleSubmit`. No RHF `<Form>` component exists in base-nova — compose `Input`/`Label`/`Alert` directly, as the auth forms do.

## Naming & style conventions

- Files: kebab-case. Action files end in `-actions.ts`; the suffix tells reviewers "this is a `"use server"` trust boundary".
- Prisma client import: `@/services/db/prisma`; generated types/enums from `@/services/db/generated/*` — never `@prisma/client`.
- UI strings are next-intl keys, never hardcoded — server: `await getTranslations("ns")`, client: `useTranslations("ns")` assigned at the top of the component. "Fund" in English strings, "caisse" in French.
- shadcn here is **base-nova on @base-ui/react, not Radix**: no `asChild` — use `buttonVariants()` for link-buttons and the `render` prop for triggers.
- Never `alert()`/`confirm()`/`prompt()`; destructive actions get an in-app confirmation dialog before the action fires.
- Route/navigation state lives in the URL (path + query params), not client state — see the members page tabs.

After scaffolding, run `npm run guard` — it mechanically enforces the client/server boundary rules. If you touched anything fund-scoped, also apply the **tenant-safety** skill.
