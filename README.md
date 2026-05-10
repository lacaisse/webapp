# La Caisse

Open source platform for managing local solidarity food funds.

## About

La Caisse is a multi-fund web app that lets organizations — local solidarity food funds and similar initiatives — manage their members, cards, tokens, and partner merchants.

The project originated as the platform built for [La CLASS](https://laclass.be) (Caisse locale de l'alimentation solidaire ASBL) by [Citizen Pay BV](https://citizenpay.be), and was open-sourced so that other funds can deploy, customize, and improve it.

## Features

- **Members** — registration, onboarding, account activation, multiple cards per account
- **Cards** — assignment, loss reporting, blocking
- **Tokens** — credit/debit, manual transfer to merchants, automatic allocations with tiered amounts (target / minimum / maximum), bank synchronization (fixed period or _pay-and-go_)
- **Merchants** — registration, Citizen Pay account connection, payments, fees, payouts
- **Admin reporting** — balance per allocation tier, total fund balance, per-merchant payment breakdown
- **Referrals** — invite codes, tokens granted to the referrer when the invitee activates
- **Transactional emails** — pre-allocation reminders, confirmations, missed-payment notices, sent via Resend
- **Multi-fund** — every fund runs under its own brand on the official instance or a self-hosted one

## Stack

- **Framework**: Next.js 16 (App Router) on React 19
- **Language**: TypeScript
- **Database**: PostgreSQL on Supabase, accessed via [Prisma](https://www.prisma.io/) 7 with the `@prisma/adapter-pg` driver adapter (Supavisor pooler in transaction mode)
- **Auth**: Supabase Auth (`@supabase/ssr` for cookie-based sessions in server components and server actions)
- **UI**: [shadcn/ui](https://ui.shadcn.com/) `base-nova` style on [Base UI](https://base-ui.com/) primitives, Tailwind CSS v4, [Lucide](https://lucide.dev/) icons
- **Forms**: `react-hook-form` + `zod` (schemas shared between client validation and server-action input parsing)
- **Hosting & cron**: Vercel
- **Open Banking & merchant payments**: Citizen Pay (custom integration)
- **Email**: Resend (transactional)

## Getting started

### Prerequisites

- Node.js 20+
- npm
- A Supabase project (Postgres + Auth)
- A Resend account (for transactional email)
- A Citizen Pay account (for merchant payment features)

### Installation

```bash
git clone https://github.com/citizenpay/lacaisse.git
cd lacaisse
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

The app runs at `http://localhost:3000`.

### Production

```bash
npm run build
npm start
```

## Configuration

Environment variables (see [.env.example](./.env.example)):

```env
# Supabase — anon key is safe in the browser
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# Database (Prisma against Supabase Postgres)
# Pooled connection (Supavisor, transaction mode, port 6543) — used by PrismaClient at runtime
DATABASE_URL=
# Direct connection (port 5432) — used by the Prisma CLI for migrations, introspection, studio
DIRECT_URL=
```

## Multi-fund architecture

Each fund runs independently and is configurable on the following dimensions:

- Custom domain name
- Logo and primary color
- Registration form
- Terms and conditions
- Interface language
- Token name (e.g. _token_, _solidaire_, etc.)

An official instance hosted by Citizen Pay is available for funds that prefer not to self-host.

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

## License

[MIT](./LICENSE) — anyone may inspect, modify, deploy, and redistribute the code, including for commercial purposes, under the terms of the license.

## Contact

- **Maintainer**: Citizen Pay BV — [citizenpay.be](https://citizenpay.be)
- **Issues**: [github.com/citizenpay/lacaisse/issues](https://github.com/citizenpay/lacaisse/issues)
