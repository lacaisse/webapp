// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  discoveryPreflight,
  protectedResourceMetadata,
} from "@/services/mcp/auth";

// RFC 9728 §3.1 path-inserted form for the `/api/mcp` resource — the
// `resource_metadata` URL our 401 challenge advertises. Same document as the
// root route.

export const GET = protectedResourceMetadata;
export const OPTIONS = discoveryPreflight;
