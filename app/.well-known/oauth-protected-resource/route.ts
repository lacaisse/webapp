// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  discoveryPreflight,
  protectedResourceMetadata,
} from "@/services/mcp/auth";

// RFC 9728 protected-resource metadata: tells MCP clients which authorization
// server (the auth host) protects THIS host's /api/mcp, and registers the
// host's resource with it on the way. The path-inserted alias the 401
// challenge points at lives in ./api/mcp/route.ts.

export const GET = protectedResourceMetadata;
export const OPTIONS = discoveryPreflight;
