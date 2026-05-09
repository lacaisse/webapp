import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Next 16 renamed `middleware.ts` to `proxy.ts` (function `proxy`).
// This refreshes Supabase auth tokens on every request so server components
// always see a fresh session. Adapted from Supabase's @supabase/ssr SSR guide.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // IMPORTANT: getUser() is the only call that triggers a token refresh.
  // Do not add code between createServerClient and this call.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // Match all request paths except for static assets, the favicon, and image
    // optimization. Auth needs to run on every page request, including
    // pre-fetched ones.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
