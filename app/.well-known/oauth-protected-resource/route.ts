// SPDX-License-Identifier: AGPL-3.0-or-later
import { oAuthProtectedResourceMetadata } from "better-auth/plugins";

import { auth } from "@/services/auth/better-auth";

// RFC 9728 protected-resource metadata: tells MCP clients which authorization
// server protects /api/mcp. Referenced by the WWW-Authenticate header that
// withMcpAuth returns on 401.

export const GET = oAuthProtectedResourceMetadata(auth);
