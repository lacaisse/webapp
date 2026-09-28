// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { createContext, useContext } from "react";

// Seeded from the `privacy` cookie by the (fund) layout. Client components
// read it with `usePrivacyMode()`; server components render `<Sensitive>`
// around personal data and let the client decide.
const PrivacyContext = createContext(false);

export function PrivacyProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <PrivacyContext.Provider value={enabled}>{children}</PrivacyContext.Provider>
  );
}

export function usePrivacyMode(): boolean {
  return useContext(PrivacyContext);
}
