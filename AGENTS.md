<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project conventions

This is an admin dashboard. Follow industry best practices for a Next.js admin app and the rules below.

## Data access
- All database calls and any external service calls that don't require the client to make them itself go through **server actions**. This keeps secrets and trust on the server.
- Database queries live in a dedicated **service folder** (e.g. `app/services/db/`) and are only imported by server actions — never by components or client code.
- External services (auth, email, payments, etc.) get their own service module under the same pattern, so they're easy to swap.

## Routing & state
- Route by **path and query parameters** so browser back/forward and shareable URLs just work. Do not stash navigation state in client-only state when a URL param would do.
- Load initial page data **server-side** wherever possible. Use `<Suspense>` boundaries with **skeleton fallbacks** for maximum perceived responsiveness.

## Mutations & UX
- For UI-affecting mutations, prioritise responsiveness: be **optimistic** (e.g. `useOptimistic`) and reconcile with the server response.
- **Never use `alert()`/`confirm()`/`prompt()`.** Use in-app modal/toast components for messaging and confirmation.
- **Always confirm destructive actions** (delete, archive, irreversible changes) with an in-app confirmation step before firing the server action.

## Stack
- **Auth**: Supabase Auth.
- **Database**: Postgres on Supabase, accessed via **Prisma** (not the Supabase JS client). Supabase JS is only for auth/storage/realtime — not for queries.
- **UI**: shadcn/ui — `style: "base-nova"`, neutral base, `iconLibrary: "lucide"`. ⚠️ The `base-nova` variant is built on **`@base-ui/react` (v1.3)**, **not Radix** — when adding components or reading docs, use Base UI primitives. Utilities: `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`.
- **Forms**: `react-hook-form` + `zod` (schemas shared between client validation and server action input parsing).
- **Hosting & cron**: Vercel.
- **Open Banking & blockchain**: **Citizenpay** (custom integration — details TBD).

## Framework gotchas worth remembering

These are non-obvious facts about the Next 16 / Prisma 7 stack that bit us during scaffolding.

### Next 16
- **`middleware.ts` is now `proxy.ts`**, function `proxy()`. Same `NextRequest`/`NextResponse` API. Runs on Node.js runtime (good for Supabase compat). See `proxy.ts` at the project root.
- **`cookies()` is async** — always `await cookies()`. Same for `headers()`.
- Use **`refresh()` from `next/cache`** (not `router.refresh()`) for client-router refresh after a Server Action.

### Prisma 7
- **`PrismaClient` requires a Driver Adapter** (or Prisma Accelerate URL). The old "just pass DATABASE_URL" path is gone. We use `@prisma/adapter-pg` — see `services/db/prisma.ts`.
- **The new `prisma-client` generator emits ESM TypeScript source files**, not compiled JS. Output is configured to `services/db/generated/` (gitignored). Import the client from `services/db/generated/client`, **not** `@prisma/client`. The `@prisma/client` package is still a peer dep but no longer the import surface for `PrismaClient`.
- **`prisma.config.ts`** replaces CLI flags / `package.json` config. The datasource URL there is what Prisma CLI uses for `migrate`, `db push`, `studio`. Runtime PrismaClient picks its own URL via the adapter — that's how we split DIRECT_URL (CLI/migrations) from DATABASE_URL (pooled, runtime).
- `.env` is **no longer auto-loaded** — `prisma.config.ts` does `import "dotenv/config"` to load it.
- **Supavisor pooler compatibility**: `@prisma/adapter-pg` disables prepared statement caching by default, so `DATABASE_URL` can point at Supabase's transaction-mode pooler (port 6543) without extra config.

### Auth (Supabase + DAL)
- The DAL (`services/auth/dal.ts`) wraps `getCurrentUser`, `requireUser`, `requireAdmin` in React's `cache()` so a single render pass only hits Supabase once.
- **Roles live in `app_metadata.role`**, not `user_metadata`. `user_metadata` is user-writable and unsafe for authorization. Setting `app_metadata` requires the service role key.
- `proxy.ts` calls `supabase.auth.getUser()` on every request — this is the only way to refresh tokens. Do not move code between `createServerClient` and `getUser()` in that file.
