import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  let next = searchParams.get("next") || "/painel";
  if (!next.startsWith("/")) next = "/painel";
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const forwardedHost = request.headers.get("x-forwarded-host");
      const targetOrigin = forwardedHost ? `https://${forwardedHost}` : origin;
      return NextResponse.redirect(`${targetOrigin}${next}`);
    }
  }
  return NextResponse.redirect(`${origin}/entrar?erro=oauth`);
}
