import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAnonKey, supabaseUrl } from "./config";
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, { cookies: { getAll: () => request.cookies.getAll(), setAll(cookiesToSet, headersToSet) { cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value)); response = NextResponse.next({ request }); cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options)); Object.entries(headersToSet).forEach(([name, value]) => response.headers.set(name, value)); } } });
  await supabase.auth.getClaims();
  return response;
}
