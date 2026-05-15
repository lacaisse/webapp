// SPDX-License-Identifier: AGPL-3.0-or-later
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { APIError } from "better-auth/api";
import { auth } from "@/services/auth/better-auth";

// Dev-only: directly invokes auth.api.signUpEmail and renders the result +
// any Set-Cookie header. Use to inspect whether Better Auth is producing a
// session cookie at all (vs. swallowing it somewhere in the Next pipeline).
//
// Visit:
//   http://auth.localhost:3000/debug/signup-test?email=test+<rand>@example.com
//
// Each load attempts a signup with the given email and a fixed password. Use
// a fresh email each time to avoid the duplicate path.

export const dynamic = "force-dynamic";

export default async function SignupTestPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const { email } = await searchParams;
  if (!email) {
    return (
      <div style={{ padding: 24, fontFamily: "monospace" }}>
        Pass <code>?email=...</code> in the URL. Use a fresh address each time.
      </div>
    );
  }

  let response: Response | null = null;
  let apiError: { status?: number; body?: unknown } | null = null;
  let unknownError: string | null = null;
  try {
    response = (await auth.api.signUpEmail({
      body: {
        email,
        password: "diagnostic-password-12345",
        name: email.split("@")[0] ?? "test",
      },
      headers: await headers(),
      asResponse: true,
    })) as Response;
  } catch (e) {
    if (e instanceof APIError) {
      apiError = { status: e.statusCode, body: e.body };
    } else {
      unknownError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }

  const setCookie = response?.headers.get("set-cookie");
  const status = response?.status;
  let body: unknown = null;
  if (response) {
    try {
      body = await response.clone().json();
    } catch {
      body = await response.clone().text();
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: "monospace", fontSize: 13 }}>
      <h1>signup-test</h1>
      <h2>input</h2>
      <pre>{JSON.stringify({ email }, null, 2)}</pre>
      <h2>API error (if thrown)</h2>
      <pre>{apiError ? JSON.stringify(apiError, null, 2) : "(none)"}</pre>
      <h2>unknown error (if thrown)</h2>
      <pre>{unknownError ?? "(none)"}</pre>
      <h2>response status</h2>
      <pre>{status ?? "(no response)"}</pre>
      <h2>response set-cookie</h2>
      <pre>{setCookie ?? "(none — this is the bug)"}</pre>
      <h2>response body</h2>
      <pre>{JSON.stringify(body, null, 2)}</pre>
    </div>
  );
}
