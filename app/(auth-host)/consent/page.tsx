// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth } from "@/services/auth/better-auth";
import { getCurrentUser } from "@/services/auth/dal";
import { readSignedOAuthQuery } from "@/services/auth/oauth-resume";
import { ConsentForm } from "./consent-form";

// MCP OAuth consent page (the provider plugin's `consentPage`). The plugin
// sends a signed-in user here with the signed authorize query when the
// client has no stored grant yet (or asked for `prompt=consent`). We show who
// is asking and what for; the decision goes back through consentAction.

export default async function ConsentPage() {
  const t = await getTranslations("auth.consent");

  const oauthQuery = await readSignedOAuthQuery();
  if (!oauthQuery) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("invalid")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // The plugin only redirects here after a sign-in, but the session may have
  // lapsed between the two (or the tab was reopened). Back through /login
  // with the same signed query: the sign-in resumes the authorize, which
  // brings the user straight back here.
  const user = await getCurrentUser();
  if (!user) redirect(`/login?${oauthQuery}`);

  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id") ?? "";
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);

  // Public client fields (name, homepage, logo) — a 404 here means the
  // client was deleted mid-flow; the form still renders and the decision
  // then fails cleanly on the plugin side.
  const client = await auth.api
    .getOAuthClientPublic({
      query: { client_id: clientId },
      headers: await headers(),
    })
    .catch(() => null);
  const clientName = client?.client_name || t("unknownClient");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>
          {t("description", { client: clientName, email: user.email })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ConsentForm
          oauthQuery={oauthQuery}
          scopes={scopes}
          clientUri={client?.client_uri ?? null}
        />
      </CardContent>
    </Card>
  );
}
