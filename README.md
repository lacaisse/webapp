# La Caisse

> **Run a fund your community counts on.**

[![CI](https://github.com/lacaisse/webapp/actions/workflows/ci.yml/badge.svg)](https://github.com/lacaisse/webapp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/lacaisse/webapp/actions/workflows/codeql.yml/badge.svg)](https://github.com/lacaisse/webapp/actions/workflows/codeql.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-38BDF8?logo=tailwindcss&logoColor=white)

**Open source · Multi-tenant · Hosted or self-hosted**

La Caisse gives solidarity funds, clubs, and community spaces the tools to manage members, track every contribution, and pay out without friction — **under your own brand, on your own terms**.

## About

La Caisse is a multi-fund web app for managing local solidarity funds — local solidarity food funds and similar initiatives — covering their members, cards, tokens, and partner merchants.

The project originated as the platform built for [La CLASS](https://laclass.be) (Caisse locale de l'alimentation solidaire ASBL) by [Citizen Pay](https://citizenpay.eu), and was open-sourced so that other funds can deploy, customize, and improve it.

## How it works

La Caisse connects three groups around a single fund:

- **Members receive and spend.** They register, get their balance credited, and spend it with a card at participating merchants — and can earn more by referring others.
- **Your team runs the fund.** Set the rules and allocations, onboard members and merchants, and keep an eye on everything from reporting dashboards.
- **Merchants and suppliers get paid.** Connect through Citizen Pay, apply configurable fees, and receive regular payouts with full transparency.

## Features

**For members**
- Registration, onboarding, and account activation
- Multiple cards per account, with loss reporting and blocking
- Scheduled balance updates and full transaction history
- Referral rewards — tokens granted to the referrer when an invitee activates

**For fund teams**
- Tiered allocations with target / minimum / maximum amounts
- Automatic allocations and bank synchronization (fixed period or _pay-and-go_)
- Member and card management
- Reporting — balance per allocation tier, total fund balance, per-merchant payment breakdown
- Branded transactional emails (pre-allocation reminders, confirmations, missed-payment notices) via Resend

**For merchants**
- Streamlined Citizen Pay account connection
- Configurable per-fund fees
- Regular payout cycles with transparent breakdowns

## Multi-tenant by design

Every fund runs independently — on the official instance or a self-hosted one — and is configurable on its own:

- Custom domain
- Logo and brand color
- Custom token / currency name (e.g. _token_, _solidaire_, …)
- Custom registration form
- Versioned terms and conditions
- Allocation rules
- Interface language
- Merchant fee structure

Funds are isolated from one another, with GDPR-conscious data handling throughout.

## Hosting & pricing

- **Hosted** — €20/month, **free for registered nonprofits and schools**. An official instance operated by Citizen Pay, for funds that prefer not to self-host. [Join the waitlist](https://lacaisse.eu).
- **Self-hosted** — **free** under the AGPL-3.0 license. Deploy it yourself (see [Getting started](#getting-started)).

## Stack

- **Framework**: Next.js 16 (App Router) on React 19
- **Language**: TypeScript
- **Database**: PostgreSQL on Supabase, accessed via [Prisma](https://www.prisma.io/) 7 with the `@prisma/adapter-pg` driver adapter (Supavisor pooler, transaction mode)
- **Auth**: [Better Auth](https://www.better-auth.com/) — cookie-based sessions plus WebAuthn passkeys
- **UI**: [shadcn/ui](https://ui.shadcn.com/) `base-nova` style on [Base UI](https://base-ui.com/) primitives, Tailwind CSS v4, [Lucide](https://lucide.dev/) icons
- **Forms**: `react-hook-form` + `zod` (schemas shared between client validation and server-action input parsing)
- **i18n**: [next-intl](https://next-intl.dev/) — cookie-based locale, no URL prefix
- **Hosting & cron**: Vercel
- **Open Banking & merchant payments**: Citizen Pay (custom integration)
- **Email**: Resend (transactional)

## Languages

The interface is available in **English**, **Français**, **Nederlands**, and **Español** (default: French). Adding a locale is a JSON file plus one entry in `services/i18n/locale.ts`.

## Getting started

### Prerequisites

- Node.js 20+
- npm
- A Supabase project (Postgres)
- A Resend account (for transactional email)
- A Citizen Pay account (for merchant payment features)

### Installation

```bash
git clone https://github.com/lacaisse/webapp.git
cd webapp
npm install
cp .env.example .env
```

Fill in the environment variables in `.env` (see [Configuration](#configuration)), then generate the Prisma client and apply migrations:

```bash
npx prisma generate
npx prisma migrate deploy
```

### Development

```bash
npm run dev
```

The app runs at `http://localhost:3000`. Funds resolve by host — visit `http://<subdomain>.localhost:3000` (modern browsers resolve `*.localhost` to `127.0.0.1` automatically).

### Production

```bash
npm run build
npm start
```

### Checks

The same checks that gate every pull request can be run locally:

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm run test        # Vitest
npm run guard       # convention & permission guards
npm run audit:ci    # dependency vulnerability gate
```

## Configuration

Environment variables (see [.env.example](./.env.example) for the full, documented list):

```env
# App — apex domain (no protocol, no subdomain) and its public mirror
APP_DOMAIN="localhost"
NEXT_PUBLIC_APP_DOMAIN="localhost"

# Better Auth — signing secret (generate with: openssl rand -hex 32)
BETTER_AUTH_SECRET=""

# Database (Prisma against Supabase Postgres)
# Pooled connection (Supavisor, transaction mode, port 6543) — runtime
DATABASE_URL=""
# Direct connection (port 5432) — Prisma CLI for migrations, studio
DIRECT_URL=""

# Email (Resend)
RESEND_API_KEY=""
EMAIL_FROM="La Caisse <noreply@lacaisse.eu>"

# At-rest encryption for secrets stored in the DB (32 bytes / 64 hex)
APP_CRED_KEY=""
```

## License

La Caisse is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](./LICENSE) for the full text.

If the AGPL-3.0 does not suit your use case, commercial licenses are available. Contact legal@lacaisse.eu to discuss.

## Contributing

Contributions are welcome — pull requests, bug reports, feature proposals. They are reviewed by Citizen Pay based on roadmap alignment, technical quality, and priority relative to ongoing work.

For any substantial new feature, please open an issue first to discuss the proposal before submitting code.

## Roadmap

The roadmap is funding-driven. An organization (fund, foundation, public body) that wants a specific feature prioritized can do so by sponsoring its development.

## Governance

Citizen Pay BV is the project's primary maintainer:

- Deployment and maintenance of the official instance
- Review and integration of external contributions
- Release and documentation management
- Roadmap coordination

## Contact

- **Maintainer**: Citizen Pay BV — [citizenpay.eu](https://citizenpay.eu)
- **Website**: [lacaisse.eu](https://lacaisse.eu)
- **Issues**: [github.com/lacaisse/webapp/issues](https://github.com/lacaisse/webapp/issues)
