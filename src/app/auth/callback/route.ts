import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
  if (error) return NextResponse.redirect(`${targetOrigin}/entrar?erro=oauth`);
  return response;
}
