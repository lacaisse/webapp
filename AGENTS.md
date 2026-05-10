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
- The DAL (`services/auth/dal.ts`) wraps `getCurrentUser`, `requireUser`, `requireAdmin`, `requireFundRole` in React's `cache()` so a single render pass only hits Supabase/Prisma once.
- `proxy.ts` calls `supabase.auth.getUser()` on every request — this is the only way to refresh tokens. Do not move code between `createServerClient` and `getUser()` in that file.
- For elevated operations (passkey session bridge, setting `app_metadata`), use `services/auth/admin.ts` — it builds a client from `SUPABASE_SERVICE_ROLE_KEY`. Server-only.

### Domain language: "fund" / "caisse"
- The core unit is a **Fund** in code, **"caisse"** in French UI strings, **"fund"** in English UI strings. The Prisma model is `Fund`, the join model is `FundMember`, the per-fund role is `FundRole`. Service folder is `services/fund/`.
- **There is no "slug" concept** — `Fund.domain` stores the full canonical hostname (e.g. `acme.lacaisse.eu` for free funds, `funds.acme.com` for paid custom domains). One field, one identity.
- The create-fund form takes a "subdomain" input from the user (just the prefix, e.g. `acme`) and the server constructs `<subdomain>.<APP_DOMAIN>` before persisting. Custom-domain UX is TBD.

### Roles & multi-fund access
- **`User.globalRole`** (`USER` | `ADMIN`) — platform-level. `requireAdmin()` reads this. Set via SQL or an admin tool. **Not** stored in Supabase metadata; lives in our Prisma User table.
- **`FundMember.role`** (`OWNER` > `ADMIN` > `MEMBER` > `VIEWER`) — per-fund. Use `requireFundRole(minRole)` for any fund-scoped resource. Returns `{ user, fund, membership }`.
- **JIT sync**: `getCurrentUser()` upserts the Supabase auth user into `User` on first read each render. There is no DB trigger or webhook — Supabase auth.users is canonical for identity, our Prisma User is canonical for app-level data (role, name, memberships).
- The `User.id` is a uuid that **mirrors `auth.users.id`** — no FK across schemas.

### Fund routing (host = identity)
- Production: `<sub>.lacaisse.eu` (free) or any custom domain (paid). Dev: `<sub>.localhost:3000` (modern browsers resolve `*.localhost` to 127.0.0.1 — no `/etc/hosts` setup needed).
- `proxy.ts` does ONE lookup: `Fund.findUnique({ where: { domain: host } })`. There's no subdomain extraction; the host IS the fund identity. Reserved infra subdomains (`www`, `api`, `admin`, `app`) short-circuit before the DB hit.
- proxy.ts always **strips inbound** `x-fund-domain` / `x-fund-id` so a client can't spoof the fund context. Sets them on a successful lookup.
- App code reads the fund via `services/fund/server.ts` (`getCurrentFund`, `getCurrentFundDomain`, `requireCurrentFund`, `getFundUrl`, `getApexUrl`). **Never re-parse the host.**
- `APP_DOMAIN` env var configures the apex (`localhost` in dev, `lacaisse.eu` in prod). `NEXT_PUBLIC_APP_DOMAIN` is the client-visible mirror (the create-fund form uses it for the suffix display).
- **Apex page logic**: `app/page.tsx` checks `getCurrentFundDomain()` first. If a domain header is set → require the fund (notFound on miss). If no domain → render the user's fund picker.
- **Cross-host redirects**: `redirect("/some-path")` stays on the current host. Use `redirect(getApexUrl("/some-path"))` when redirecting from a fund subdomain back to apex (e.g. `/account/*` pages).

### Forms (RHF + Zod + Server Actions)
- Pattern: client component uses `useForm` + `zodResolver`, calls a server action from inside `handleSubmit` via `useTransition`. Server action re-validates with the same Zod schema (don't trust the client). See `app/(auth)/login/login-form.tsx`.
- The server action returns `{ error: string } | { ok: true; ... }` on failure/info, or **doesn't return** (calls `redirect()`) on success.
- Schemas live in a non-`"use server"` file so they can be imported by both client and server.
- ⚠️ **`"use server"` files can only export async functions.** Exporting constants, types, schemas, or anything else gets silently transformed into a server-reference proxy. Build passes, runtime explodes the moment a client tries to use it (`X.map is not a function`, etc.). Co-locate non-action exports in a sibling `config.ts` / `schema.ts` and import from there.
- **Schema error messages are i18n keys** (e.g. `"auth.errors.passwordMin"`), not human strings. Forms call `tRoot(message as never, { min: ... } as never)` to resolve them. Server actions translate via `getTranslations()` before returning.

### Internationalization (next-intl)
- Cookie-based locale (no URL prefix). Default locale: **`fr`**.
- Messages live in `messages/fr.json` + `messages/en.json`. Add a new locale = add a JSON file + extend `SUPPORTED_LOCALES` in `services/i18n/locale.ts`.
- Server: `await getTranslations("namespace")`. Client: `useTranslations("namespace")`. Never call hooks inside JSX — assign at the top of the component.
- For dynamic key lookup (e.g. resolving a message that came from a Zod schema), get a "root" `t` via `useTranslations()` (no namespace) and pass `key as never` to bypass the strict key typing.
- Locale switcher: `components/locale-switcher.tsx`, embedded in the auth layout footer.

### Passkeys (WebAuthn)
- **Supabase has no native WebAuthn** — we self-implement with `@simplewebauthn/{server,browser}`. Credentials live in `WebAuthnCredential` (Prisma).
- **rpID** = `APP_DOMAIN` (the apex), so a passkey registered on `acme.lacaisse.eu` works on every fund subdomain. See `services/auth/webauthn.ts`.
- **Session bridge**: after passkey verify, the route handler calls `auth.admin.generateLink({ type: 'magiclink', email })`, grabs `properties.email_otp`, and immediately calls `supabase.auth.verifyOtp({ ..., type: 'email' })` on the SSR client — which writes the Supabase session cookies. Requires `SUPABASE_SERVICE_ROLE_KEY`.
- **Challenges** are stored in HttpOnly `wa_reg_challenge` / `wa_auth_challenge` cookies (5 min TTL, SameSite=Strict). Cleared after one use.
- **Uint8Array typing trick**: simplewebauthn defines `Uint8Array_ = ReturnType<Uint8Array['slice']>` to dodge TS 5.7+ ArrayBuffer typing. Pass `bytes.slice()` rather than raw `bytes` when in doubt.

### Email (Resend, two layers)
- **Supabase Auth emails** (signup verification, password reset, the magic-link OTP that the passkey bridge consumes) are sent by **Supabase**, not us. We point them at Resend by configuring custom SMTP in the Supabase dashboard (`smtp.resend.com:587`, username `resend`, password = a Resend API key with sending scope). No code change required to switch providers — change the dashboard, redeploy nothing.
- **Our direct transactional sends** (fund invites, welcome flow, anything we trigger from a server action) go through `services/email/resend.ts` (`sendEmail({ to, subject, text/html, replyTo })`). Uses `RESEND_API_KEY` + `EMAIL_FROM` from env. Throws on Resend errors so the caller decides whether to surface or log+continue.
- Don't reach for the Resend SDK directly from a route or action — always go through `services/email/`. Same swap-out story as the rest of the service modules.
- React Email isn't set up yet. When we need branded templates, install `@react-email/components` and add a `services/email/templates/` directory; render to HTML via `render()` and pass to `sendEmail({ html })`.

### shadcn base-nova vs Radix shadcn
- **No `asChild` prop on Button** (and other primitives). To style a `<Link>` like a button, use the exported `buttonVariants({ variant })` as a className. For dialog triggers and similar, Base UI primitives accept a **`render` prop** (e.g. `<DialogTrigger render={<Button>...</Button>} />`).
- The `form` component (Form/FormField/FormItem/FormLabel/FormMessage) **does not exist** in base-nova. Compose RHF directly with `Input`/`Label`/`Alert` — see the auth forms for the canonical pattern.
