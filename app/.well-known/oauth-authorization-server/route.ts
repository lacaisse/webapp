// SPDX-License-Identifier: AGPL-3.0-or-later
import { oAuthDiscoveryMetadata } from "better-auth/plugins";

import { auth } from "@/services/auth/better-auth";

// RFC 8414 authorization-server metadata at the root .well-known path — MCP
// clients probe this (and the /api/auth-scoped copy Better Auth serves
// itself) to find the authorize/token/register endpoints.

export const GET = oAuthDiscoveryMetadata(auth);
