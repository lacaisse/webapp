// SPDX-License-Identifier: AGPL-3.0-or-later

// The WebAuthn relying-party id of a Safe signing passkey. In production it
// is the apex (`lacaisse.eu`), like the login passkey plugin, so a credential
// registered on `acme.lacaisse.eu` is valid on every host of the fund. In dev
// the apex is `localhost`, which browsers refuse as an RP id for a
// `<sub>.localhost` origin ("The RP ID is invalid for this domain"), so the
// request host itself is used there — a signing passkey is per fund anyway,
// and the Safe pages live on the fund host. Pure: the server action and the
// page that hands the id to the browser both call it.
export function signingPasskeyRpId(appDomain: string, requestHost: string): string {
  if (appDomain !== "localhost") return appDomain;
  const host = requestHost.split(":")[0] ?? "";
  return host || "localhost";
}
