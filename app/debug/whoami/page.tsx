import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/services/auth/better-auth";
import { getHostType } from "@/services/host/server";

// Dev-only diagnostic. Visit on auth.localhost / localhost / <fund>.localhost
// to see what the server sees: host classification, cookies, and the
// resolved Better Auth session. Use this to debug cross-subdomain session
// propagation.

export const dynamic = "force-dynamic";

export default async function WhoamiPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const h = await headers();
  const c = await cookies();
  const hostType = await getHostType();
  const host = h.get("host") ?? "(no host header)";

  const allCookies = c.getAll().map((x) => ({ name: x.name, value: x.value }));

  let session: unknown = null;
  let sessionError: string | null = null;
  try {
    session = await auth.api.getSession({ headers: h });
  } catch (e) {
    sessionError = e instanceof Error ? e.message : String(e);
  }

  return (
    <div style={{ padding: 24, fontFamily: "monospace", fontSize: 13 }}>
      <h1>whoami</h1>
      <h2>host</h2>
      <pre>
        {JSON.stringify({ host, hostType, appDomain: process.env.APP_DOMAIN }, null, 2)}
      </pre>
      <h2>cookies seen by server ({allCookies.length})</h2>
      <pre>{JSON.stringify(allCookies, null, 2)}</pre>
      <h2>raw Cookie header</h2>
      <pre>{h.get("cookie") ?? "(no cookie header)"}</pre>
      <h2>auth.api.getSession()</h2>
      <pre>{sessionError ?? JSON.stringify(session, null, 2)}</pre>
    </div>
  );
}
