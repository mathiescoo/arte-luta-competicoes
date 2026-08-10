import { createBrowserClient } from "@supabase/ssr";

const PROJECT_URL = "https://chgwkxejisnvlsspwbmq.supabase.co";
// Esta é uma chave "anon" pública: ela é feita para existir no navegador.
// A autorização real continua protegida pelas regras (RLS) do Supabase.
const PROJECT_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNoZ3dreGVqaXNudmxzc3B3Ym1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNDUxNTUsImV4cCI6MjEwMTYyMTE1NX0.c4WqeuhfSIj1P3Ms33raJbwdTU5SWN_T6BhUs9xXsE8";

function publicValue(value: string | undefined) {
  return (value ?? "").replace(/[\s\r\n]+/g, "").replace(/^['\"]|['\"]$/g, "");
}

export function createClient() {
  const configuredUrl = publicValue(process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, "");
  const supabaseUrl = configuredUrl === PROJECT_URL ? configuredUrl : PROJECT_URL;
  // A configuração da Vercel recebeu uma chave JWT de assinatura inválida.
  // Usa a chave anon verificada até essa variável ser corrigida no painel.
  const supabaseAnonKey = PROJECT_ANON_KEY;

  return createBrowserClient(
    supabaseUrl,
    supabaseAnonKey,
    { auth: { flowType: "pkce", detectSessionInUrl: false } },
  );
}
