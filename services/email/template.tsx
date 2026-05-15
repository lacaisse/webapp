// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Section,
  Text,
  render,
} from "react-email";
import * as React from "react";

// Hex equivalents of the oklch tokens in app/globals.css. Email clients
// don't understand oklch — keep these in sync if the design-system warm
// neutral palette shifts.
const COLORS = {
  background: "#fbf9f5",
  card: "#ffffff",
  foreground: "#2a2620",
  mutedForeground: "#807769",
  border: "#e2ddd5",
  muted: "#f1eee8",
  primaryFg: "#ffffff",
};
const DEFAULT_PRIMARY = "#c46a4a";

const FONT_DISPLAY = `'Fraunces', 'Iowan Old Style', Georgia, serif`;
const FONT_SANS = `'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
const FONT_MONO = `'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace`;

function normalizeHex(color: string | null | undefined): string {
  if (!color) return DEFAULT_PRIMARY;
  const t = color.trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(t)) return DEFAULT_PRIMARY;
  return t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`;
}

export type BrandedEmailArgs = {
  fundName: string;
  primaryColor: string | null;
  logoUrl: string | null;
  subject: string;
  text: string;
  // Localised CTA button label. When set AND a paragraph in `text` is a
  // bare URL, that paragraph renders as a primary button. When unset,
  // bare-URL paragraphs render as a plain link.
  ctaLabel?: string;
};

export async function renderBrandedEmail(
  args: BrandedEmailArgs,
): Promise<string> {
  return render(<EmailTemplate {...args} />);
}

function EmailTemplate({
  fundName,
  primaryColor,
  logoUrl,
  subject,
  text,
  ctaLabel,
}: BrandedEmailArgs) {
  const brand = normalizeHex(primaryColor);
  const blocks = text.split(/\n{2,}/);

  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light only" />
      </Head>
      <Preview>{subject}</Preview>
      <Body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: COLORS.background,
          fontFamily: FONT_SANS,
          color: COLORS.foreground,
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <Container
          style={{
            maxWidth: 560,
            margin: "0 auto",
            padding: "40px 16px",
          }}
        >
          <Section
            style={{
              backgroundColor: COLORS.card,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 12,
              padding: "32px 32px 24px",
            }}
          >
            <BrandHeader fundName={fundName} logoUrl={logoUrl} />
            {blocks.map((block, i) => (
              <Block
                key={i}
                text={block}
                brand={brand}
                ctaLabel={ctaLabel}
              />
            ))}
          </Section>
          <Text
            style={{
              margin: "20px 0 0",
              fontSize: 12,
              lineHeight: "16px",
              color: COLORS.mutedForeground,
              textAlign: "center",
              letterSpacing: "0.04em",
            }}
          >
            Sent via La caisse
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

function BrandHeader({
  fundName,
  logoUrl,
}: {
  fundName: string;
  logoUrl: string | null;
}) {
  return (
    <Section style={{ paddingBottom: 24 }}>
      {logoUrl ? (
        <Img
          src={logoUrl}
          alt={fundName}
          height={36}
          style={{ maxHeight: 36, display: "block" }}
        />
      ) : (
        <Heading
          as="h1"
          style={{
            margin: 0,
            fontFamily: FONT_DISPLAY,
            fontWeight: 500,
            fontSize: 22,
            lineHeight: "30px",
            letterSpacing: "-0.01em",
            color: COLORS.foreground,
          }}
        >
          {fundName}
        </Heading>
      )}
    </Section>
  );
}

function Block({
  text,
  brand,
  ctaLabel,
}: {
  text: string;
  brand: string;
  ctaLabel?: string;
}) {
  const trimmed = text.trim();

  if (/^https?:\/\/\S+$/.test(trimmed)) {
    return <CtaBlock url={trimmed} brand={brand} label={ctaLabel} />;
  }

  // Indented paragraph (every line starts with 2+ spaces) and not a URL →
  // render as a muted value box (payment reference, card serial, free-text
  // rejection reason, etc.).
  const lines = text.split("\n");
  if (lines.length > 0 && lines.every((l) => l.startsWith("  "))) {
    return (
      <Section
        style={{
          backgroundColor: COLORS.muted,
          borderRadius: 8,
          padding: "12px 16px",
          margin: "0 0 18px",
        }}
      >
        {lines.map((line, i) => (
          <Text
            key={i}
            style={{
              margin: 0,
              fontFamily: FONT_MONO,
              fontSize: 14,
              lineHeight: "22px",
              color: COLORS.foreground,
              wordBreak: "break-word",
            }}
          >
            {line.replace(/^ {2}/, "")}
          </Text>
        ))}
      </Section>
    );
  }

  return (
    <Text
      style={{
        margin: "0 0 16px",
        fontSize: 15,
        lineHeight: "23px",
        color: COLORS.foreground,
      }}
    >
      {text.split("\n").flatMap((line, j, arr) =>
        j < arr.length - 1
          ? [
              <React.Fragment key={`l${j}`}>{line}</React.Fragment>,
              <br key={`br${j}`} />,
            ]
          : [<React.Fragment key={`l${j}`}>{line}</React.Fragment>],
      )}
    </Text>
  );
}

function CtaBlock({
  url,
  brand,
  label,
}: {
  url: string;
  brand: string;
  label?: string;
}) {
  if (!label) {
    return (
      <Text
        style={{
          margin: "0 0 16px",
          fontSize: 14,
          color: brand,
          wordBreak: "break-all",
        }}
      >
        <a
          href={url}
          style={{ color: brand, textDecoration: "underline" }}
        >
          {url}
        </a>
      </Text>
    );
  }
  return (
    <Section style={{ padding: "4px 0 20px" }}>
      <Button
        href={url}
        style={{
          backgroundColor: brand,
          color: COLORS.primaryFg,
          padding: "12px 22px",
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 500,
          textDecoration: "none",
          display: "inline-block",
          fontFamily: FONT_SANS,
        }}
      >
        {label}
      </Button>
      <Text
        style={{
          margin: "10px 0 0",
          fontSize: 12,
          lineHeight: "18px",
          color: COLORS.mutedForeground,
          wordBreak: "break-all",
        }}
      >
        {url}
      </Text>
    </Section>
  );
}
