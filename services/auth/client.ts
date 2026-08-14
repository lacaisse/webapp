// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";

// Browser-side Better Auth client. baseURL is omitted — when the auth handler
// is mounted at /api/auth on the same origin, the client defaults to the
// current origin, which lets the same client code run on every fund subdomain
// without rewiring (the request goes to that subdomain's /api/auth/* route,
// which sets a host-only session cookie for that host — cross-host handoff
// goes through /auth/exchange, not a shared .APP_DOMAIN cookie).
//
// Use this from "use client" components: signIn.email, signUp.email,
// signIn.passkey, passkey.addPasskey, passkey.deletePasskey, signOut, etc.

export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

export const { signIn, signUp, signOut, passkey, useSession } = authClient;
