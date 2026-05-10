# Design system

A multi-fund design system: a fixed base (typography, neutrals, semantic colors, spacing, radii, motion) and a thin layer of fund-flexible tokens (brand color, logo). Same skeleton, different skin.

## Philosophy

Built for non-profits, clubs, and solidarity funds. Three values guide every choice.

**Warm.** Off-white surfaces with a cream undertone; neutrals carry a faint warm hue rather than sitting at pure gray; generous radii. Nothing clinical.

**Human.** A characterful serif for display, a humanist sans for body. Real type, not screens-of-the-future type.

**Readable, professional.** High contrast where it matters. Restraint everywhere else. Suitable for a 60-year-old volunteer treasurer and a 25-year-old developer.

## What's locked, what flexes

| Layer                                                 | Locked | Per-fund |
| ----------------------------------------------------- | ------ | ---------- |
| Typography                                            | ✓      | —          |
| Neutrals (background, surfaces, borders, text)        | ✓      | —          |
| Semantic colors (success, warning, info, destructive) | ✓      | —          |
| Spacing, radii, shadows                               | ✓      | —          |
| Motion                                                | ✓      | —          |
| Brand color (`--primary`)                             | —      | ✓          |
| Logo                                                  | —      | ✓          |

The brand color applies to buttons, links, focus rings, and the few accents that need a fund signature. Everything else is shared so the platform feels like one product across funds — rather than fifteen sites with different fonts and spacing.

## Tokens

### Color — locked neutrals

All colors are `oklch`, which gives perceptual lightness and avoids muddy interpolation when we tint or dim.

The neutrals carry a faint warm hue (≈75°, very low chroma) so even a "white" surface reads as off-white-with-cream rather than fluorescent.

| Token                | Light                  | Dark                   | Use                           |
| -------------------- | ---------------------- | ---------------------- | ----------------------------- |
| `--background`       | `oklch(0.99 0.005 75)` | `oklch(0.16 0.008 75)` | Page background               |
| `--foreground`       | `oklch(0.18 0.012 75)` | `oklch(0.96 0.005 75)` | Body text                     |
| `--card`             | `oklch(1 0 0)`         | `oklch(0.20 0.010 75)` | Card surfaces                 |
| `--muted`            | `oklch(0.96 0.008 75)` | `oklch(0.24 0.012 75)` | Subtle bg for tags, skeletons |
| `--muted-foreground` | `oklch(0.50 0.018 75)` | `oklch(0.68 0.015 75)` | Captions, helpers             |
| `--border`           | `oklch(0.91 0.012 75)` | `oklch(1 0 0 / 10%)`   | All hairlines                 |

### Color — locked semantics

Same in both modes (with `-foreground` companions). These are intentionally a hair desaturated from the usual web defaults so they sit alongside the warm neutrals without screaming.

| Token           | Value                  | Use                          |
| --------------- | ---------------------- | ---------------------------- |
| `--success`     | `oklch(0.55 0.13 145)` | Confirmation states          |
| `--warning`     | `oklch(0.72 0.14 75)`  | Caution, missed payments     |
| `--info`        | `oklch(0.58 0.12 235)` | Neutral notifications        |
| `--destructive` | `oklch(0.55 0.20 27)`  | Errors, irreversible actions |

### Color — per-fund brand

Each fund supplies one or two values:

| Token                  | Required | Notes                                                                                   |
| ---------------------- | -------- | --------------------------------------------------------------------------------------- |
| `--primary`            | yes      | Brand color in oklch. Aim for L between 0.45 and 0.65 to keep contrast with both modes. |
| `--primary-foreground` | no       | Defaults to `oklch(0.99 0 0)` (near-white). Override if your brand is light.            |

Hover, active, and tinted states are derived from `--primary` via opacity (`bg-primary/80`, `bg-primary/10`) — no shade scale required.

The default primary, used by the official La Caisse instance, is a warm terracotta: `oklch(0.58 0.13 35)`.

### Typography

| Token            | Value      | Use                           |
| ---------------- | ---------- | ----------------------------- |
| `--font-sans`    | Geist      | Body, UI                      |
| `--font-display` | Fraunces   | Headings, hero copy           |
| `--font-mono`    | Geist Mono | Numbers in tables, codes, IDs |

Fraunces is a variable serif explicitly designed for warmth — soft swashes, optical sizing, `opsz` and `softness` axes. Use it for `<h1>`–`<h3>` and the occasional emphatic display number (a fund balance, a token total). For everything else, Geist's neutrality keeps the eye on content.

Type scale (Tailwind defaults; the relevant sizes for our admin context):

| Class       | Size / Leading | Use                           |
| ----------- | -------------- | ----------------------------- |
| `text-xs`   | 12 / 16        | Labels, captions              |
| `text-sm`   | 14 / 20        | Body small, table cells       |
| `text-base` | 16 / 24        | Body                          |
| `text-lg`   | 18 / 28        | Subheads                      |
| `text-2xl`  | 24 / 32        | Section headings              |
| `text-4xl`  | 36 / 40        | Page titles                   |
| `text-6xl`  | 60 / 64        | Hero numbers, balance display |

### Radii, spacing, shadows

| Token          | Value                       |
| -------------- | --------------------------- |
| `--radius`     | `0.625rem` (10px, base)     |
| `--radius-sm`  | `calc(var(--radius) * 0.6)` |
| `--radius-md`  | `calc(var(--radius) * 0.8)` |
| `--radius-lg`  | `var(--radius)`             |
| `--radius-xl`  | `calc(var(--radius) * 1.4)` |
| `--radius-2xl` | `calc(var(--radius) * 1.8)` |

Spacing follows Tailwind's default 4px scale.

Shadows are restrained — at most two levels:

- `shadow-sm` for cards at rest
- `shadow-md` for popovers and modals (rarely)

No drop-shadow soup.

### Motion

| Token             | Value                            | Use                        |
| ----------------- | -------------------------------- | -------------------------- |
| `--ease-out`      | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Default ease for entrances |
| `--ease-in-out`   | `cubic-bezier(0.4, 0, 0.2, 1)`   | Layout shifts              |
| `--duration-fast` | `120ms`                          | Hovers, tooltips           |
| `--duration-base` | `200ms`                          | Most transitions           |
| `--duration-slow` | `400ms`                          | Modal/sheet entrances      |

Respect `prefers-reduced-motion` everywhere.

## Per-fund injection

Funds are resolved server-side from the request hostname (proxy.ts forwards `x-fund-id` / `x-fund-domain`). The resolved `FundBranding` object is injected once at the top of the document via an inline `<style>` block in `app/layout.tsx`.

```tsx
// app/layout.tsx
import localFont from "next/font/local";
import { renderFundThemeStyle } from "@/services/fund/theme";
import { getCurrentFund } from "@/services/fund/server";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/Geist-VariableFont.ttf",
  variable: "--font-sans",
});
const geistMono = localFont({
  src: "./fonts/GeistMono-VariableFont.ttf",
  variable: "--font-geist-mono",
});
const fraunces = localFont({
  src: "./fonts/Fraunces-VariableFont.ttf",
  variable: "--font-display",
});

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const fund = await getCurrentFund();
  return (
    <html
      lang={fund.locale}
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <head>
        <style
          dangerouslySetInnerHTML={{
            __html: renderFundThemeStyle(fund.theme),
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
```

Why a `<style>` block and not inline `style={{}}` on `<html>`? We override both `:root` and `.dark` in one pass; inline style only sets one cascade level.

The `dangerouslySetInnerHTML` is safe because `renderFundThemeStyle` only emits CSS variables, and the values are validated as oklch strings on fund config save (`isValidOklch`). User content never reaches the style tag.

Logos render through a `<FundLogo />` component (TBD) that reads from the same fund context and picks `logoLight` or `logoDark` based on the active mode.

## Example funds

```ts
// La CLASS — the fund this was built for. Default warm terracotta.
{
  name: "La CLASS",
  theme: { primary: "oklch(0.58 0.13 35)" },
  logoLight: "/funds/laclass/logo.svg",
  logoDark:  "/funds/laclass/logo-dark.svg",
}

// A sage-green fund focused on local farms.
{
  name: "Marché Solidaire",
  theme: { primary: "oklch(0.50 0.10 150)" },
  logoLight: "/funds/marche/logo.svg",
}

// A burgundy/wine fund — civic, dignified.
{
  name: "Caisse de Quartier",
  theme: { primary: "oklch(0.45 0.13 20)" },
  logoLight: "/funds/quartier/logo.svg",
}
```

## Adding a new component

When you `npx shadcn add` a new component, it'll come with the base-nova styling and pull from these tokens automatically. The only thing to double-check: any color that should respond to fund brand uses `bg-primary` / `text-primary` / `ring-primary`. Everything else stays on neutrals or semantics.
