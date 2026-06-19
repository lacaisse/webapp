// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import path from "node:path";

import {
  Document,
  Font,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

// Renders an editable document body (markdown-ish text, already interpolated)
// to a PDF buffer via @react-pdf/renderer. We deliberately support only the
// small markdown subset the letter templates use — headings (`#`/`##`),
// `**bold**`, `*italic*`, `---` rules, `[pagebreak]` (forces a new page) and
// blank-line paragraphs — rather than a full markdown engine, so the layout
// stays predictable on A4.
//
// The letter carries the fund's branding (Settings → Branding): the header
// (logo or the fund name as a wordmark + the full name as a subtitle), the
// primary colour on headings, and the dashboard's typeface (Geist), so a
// downloaded letter matches everything else the fund ships.

// Fallback brand colour — matches the email shell default (services/email/template.tsx).
const DEFAULT_PRIMARY = "#c46a4a";
const FOREGROUND = "#1f2937";
// Header subtitle / accent green — the dashboard's --success token
// (oklch(0.55 0.13 145)) as hex. Used for the full-name subtitle under the
// wordmark, matching the dashboard's brand pairing.
const ACCENT_GREEN = "#2f9e44";

// Register the dashboard typeface (Geist) so the PDF matches the app UI. We use
// static instances generated from the variable font (Geist-Regular/SemiBold) —
// react-pdf doesn't select weight axes on variable fonts, so a single VF can't
// give real bold. If the files can't be loaded (e.g. an unexpected runtime
// layout), we fall back to the built-in Helvetica family so a letter still
// renders.
const FONT_DIR = path.join(process.cwd(), "app", "fonts");
let FONT_FAMILY = "Helvetica";
try {
  Font.register({
    family: "Geist",
    fonts: [
      { src: path.join(FONT_DIR, "Geist-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONT_DIR, "Geist-SemiBold.ttf"), fontWeight: 700 },
    ],
  });
  // Don't hyphenate — keep words whole (the letter body is justified, matching
  // the dashboard/reference look).
  Font.registerHyphenationCallback((word) => [word]);
  FONT_FAMILY = "Geist";
} catch (e) {
  console.warn("[document] Geist font registration failed; using Helvetica", e);
}

// Accept a #rrggbb (with or without leading #), else fall back to the default.
function normalizeHex(color: string | null | undefined): string {
  if (!color) return DEFAULT_PRIMARY;
  const t = color.trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(t)) return DEFAULT_PRIMARY;
  return t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`;
}

export type DocumentBranding = {
  fundName: string;
  fullName: string | null;
  primaryColor: string | null;
  logoUrl: string | null;
};

const styles = StyleSheet.create({
  page: {
    paddingVertical: 56,
    paddingHorizontal: 56,
    fontFamily: FONT_FAMILY,
    fontSize: 10.5,
    lineHeight: 1.5,
    color: FOREGROUND,
  },
  header: { marginBottom: 24 },
  logo: { maxHeight: 48, maxWidth: 240, objectFit: "contain" },
  wordmark: { fontSize: 26, fontWeight: 700, lineHeight: 1.2 },
  subtitle: { fontSize: 13, marginTop: 5, color: ACCENT_GREEN },
  headerDivider: {
    marginTop: 14,
    borderBottomWidth: 2,
  },
  h1: {
    fontSize: 16,
    fontWeight: 700,
    marginTop: 16,
    marginBottom: 8,
  },
  h2: {
    fontSize: 12.5,
    fontWeight: 700,
    marginTop: 14,
    marginBottom: 4,
  },
  paragraph: { marginBottom: 9, textAlign: "justify" },
  line: {},
  hr: {
    borderBottomWidth: 1,
    borderBottomColor: "#d1d5db",
    marginVertical: 12,
  },
});

// react-pdf's <Image> only rasterises PNG/JPEG. Fetch the fund logo ourselves so
// we can (a) embed it as a data URI without relying on react-pdf's network layer
// and (b) skip unsupported formats (e.g. SVG) gracefully rather than throwing
// mid-render. Returns null on any failure — the caller falls back to the name.
async function loadLogoDataUri(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null;
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const type = contentType.includes("png")
      ? "image/png"
      : contentType.includes("jpeg") || contentType.includes("jpg")
        ? "image/jpeg"
        : null;
    if (!type) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch (e) {
    console.warn("[document] logo fetch failed", logoUrl, e);
    return null;
  }
}

type InlineRun = { text: string; bold: boolean; italic: boolean };

// Split a line into styled runs, honouring **bold** and *italic*. Only the flat
// (non-nested) forms the templates use are recognised; anything else is plain.
function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const regex = /(\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) {
      runs.push({ text: text.slice(last, m.index), bold: false, italic: false });
    }
    if (m[2] !== undefined) {
      runs.push({ text: m[2], bold: true, italic: false });
    } else if (m[3] !== undefined) {
      runs.push({ text: m[3], bold: false, italic: true });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    runs.push({ text: text.slice(last), bold: false, italic: false });
  }
  return runs.length > 0 ? runs : [{ text, bold: false, italic: false }];
}

type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; lines: string[] }
  | { kind: "hr" }
  | { kind: "pagebreak" };

// Block-level parse: blank lines separate paragraphs, `---` is a rule, `# `/`## `
// are headings; otherwise consecutive lines accumulate into one paragraph with
// each source line kept on its own row (so address blocks keep their breaks).
function parseBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) {
      blocks.push({ kind: "p", lines: para });
      para = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
    } else if (/^\[pagebreak\]$/i.test(trimmed)) {
      flush();
      blocks.push({ kind: "pagebreak" });
    } else if (/^-{3,}$/.test(trimmed)) {
      flush();
      blocks.push({ kind: "hr" });
    } else if (line.startsWith("# ")) {
      flush();
      blocks.push({ kind: "h1", text: line.slice(2) });
    } else if (line.startsWith("## ")) {
      flush();
      blocks.push({ kind: "h2", text: line.slice(3) });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((run, i) => (
        // Bold maps to the SemiBold instance; italic has no Geist cut, so it
        // renders in the regular weight (the dashboard synthesises oblique in
        // the browser, which we can't reproduce in the PDF).
        <Text key={i} style={run.bold ? { fontWeight: 700 } : undefined}>
          {run.text}
        </Text>
      ))}
    </>
  );
}

function BrandHeader({
  branding,
  brand,
  logoDataUri,
}: {
  branding: DocumentBranding;
  brand: string;
  logoDataUri: string | null;
}) {
  const subtitle = branding.fullName?.trim();
  return (
    <View style={styles.header}>
      {logoDataUri ? (
        // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf <Image> has no alt
        <Image src={logoDataUri} style={styles.logo} />
      ) : (
        <Text style={[styles.wordmark, { color: brand }]}>
          {branding.fundName}
        </Text>
      )}
      {subtitle && subtitle !== branding.fundName ? (
        <Text style={styles.subtitle}>{subtitle}</Text>
      ) : null}
      <View style={[styles.headerDivider, { borderBottomColor: brand }]} />
    </View>
  );
}

function LetterBody({ body, brand }: { body: string; brand: string }) {
  const blocks = parseBlocks(body);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "pagebreak") return <View key={i} break />;
        if (block.kind === "hr") return <View key={i} style={styles.hr} />;
        if (block.kind === "h1" || block.kind === "h2") {
          return (
            <Text
              key={i}
              style={[
                block.kind === "h1" ? styles.h1 : styles.h2,
                { color: brand },
              ]}
            >
              <InlineText text={block.text} />
            </Text>
          );
        }
        return (
          <View key={i} style={styles.paragraph}>
            {block.lines.map((line, j) => (
              <Text key={j} style={styles.line}>
                <InlineText text={line} />
              </Text>
            ))}
          </View>
        );
      })}
    </>
  );
}

// Render a fully-interpolated document body to a PDF buffer, carrying the fund's
// branding (logo + primary colour on headings).
export async function renderDocumentPdf(
  body: string,
  branding: DocumentBranding,
): Promise<Buffer> {
  const brand = normalizeHex(branding.primaryColor);
  const logoDataUri = await loadLogoDataUri(branding.logoUrl);
  const doc = (
    <Document>
      <Page size="A4" style={styles.page} wrap>
        <BrandHeader
          branding={branding}
          brand={brand}
          logoDataUri={logoDataUri}
        />
        <LetterBody body={body} brand={brand} />
      </Page>
    </Document>
  );
  return renderToBuffer(doc);
}
