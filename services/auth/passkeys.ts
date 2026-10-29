// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { prisma } from "@/services/db/prisma";

// Whether the user can step up with a passkey: the re-auth dialog
// (components/reauth-dialog.tsx) offers it next to the password only then.
// Loaded server-side by the pages whose actions require step-up (the Safe
// detail page, the /token page) and handed to the client as a boolean.
export const userHasPasskey = cache(async (userId: string): Promise<boolean> => {
  return (await prisma.passkey.count({ where: { userId } })) > 0;
});
