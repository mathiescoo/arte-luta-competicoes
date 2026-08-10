import { createBrowserClient } from "@supabase/ssr";

function publicValue(value: string | undefined) {
  return (value ?? "").replace(/[\s\r\n]+/g, "").replace(/^['\"]|['\"]$/g, "");
}

export function createClient() {
  const supabaseUrl = publicValue(process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, "");
  const supabaseAnonKey = publicValue(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("As credenciais públicas do Supabase não foram configuradas.");
  }

  return createBrowserClient(
    supabaseUrl,
    supabaseAnonKey,
    { auth: { flowType: "pkce", detectSessionInUrl: false } },
  );
}
