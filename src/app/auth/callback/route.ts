import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/config";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  let next = searchParams.get("next") || "/painel";
  if (!next.startsWith("/")) next = "/painel";

  const forwardedHost = request.headers.get("x-forwarded-host");
  const targetOrigin = forwardedHost ? `https://${forwardedHost}` : origin;
  const response = NextResponse.redirect(`${targetOrigin}${next}`);

  if (!code) return NextResponse.redirect(`${targetOrigin}/entrar?erro=oauth`);

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${targetOrigin}/auth/complete?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`);
  return response;
}
