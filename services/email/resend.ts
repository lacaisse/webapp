// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { Resend } from "resend";

// Direct transactional sends (fund invites, welcome flow, etc.). Auth emails
// — e.g. password reset — are sent by us too: Better Auth callbacks in
// services/auth/better-auth.ts (sendResetPassword) call sendEmail() here.
// There's no external SMTP layer; every send flows through this module.

let cached: Resend | undefined;

function getResend(): Resend {
  if (cached) return cached;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not set");
  }
  cached = new Resend(apiKey);
  return cached;
}

function getFromAddress(): string {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error("EMAIL_FROM is not set (e.g. \"La Caisse <noreply@lacaisse.eu>\")");
  }
  return from;
}

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  /** Plain text body. At least one of `text` or `html` must be provided. */
  text?: string;
  /** HTML body. At least one of `text` or `html` must be provided. */
  html?: string;
  /** Optional reply-to address; defaults to the from address. */
  replyTo?: string;
  /**
   * Optional From override (e.g. a per-fund sender). Falls back to the
   * platform EMAIL_FROM when omitted. Caller is responsible for a verified
   * domain — Resend rejects unverified senders.
   */
  from?: string;
};

/**
 * Send a transactional email via Resend.
 *
 * Throws on Resend API errors so callers can decide whether to surface
 * them or silently log + continue (e.g. invite sends that shouldn't block
 * the create-user response).
 */
export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  if (!input.text && !input.html) {
    throw new Error("sendEmail requires `text` or `html`");
  }
  const resend = getResend();
  // Resend v6's send() is a discriminated union (template branch vs
  // content branch). The runtime check above guarantees we're in the
  // content branch with at least one of html/text — the cast satisfies
  // TypeScript without us mirroring the whole union shape.
  const payload = {
    from: input.from ?? getFromAddress(),
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    replyTo: input.replyTo,
  } as Parameters<typeof resend.emails.send>[0];

  const { data, error } = await resend.emails.send(payload);
  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
  if (!data) {
    throw new Error("Resend returned no data");
  }
  return { id: data.id };
}
