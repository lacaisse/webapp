import "server-only";
import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client using the service role key. NEVER import this
// from a client component or browser-shipped code. Use only inside server
// actions, route handlers, or server components for admin-level operations:
//   - bridging a verified passkey to a Supabase session
//     (`auth.admin.generateLink`)
//   - mutating user app_metadata
//   - any other operation requiring elevated privileges
//
// This client does NOT use cookies — it's a stateless admin client.

let cached: ReturnType<typeof createClient> | undefined;

export function createSupabaseAdminClient() {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }
  cached = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return cached;
}
