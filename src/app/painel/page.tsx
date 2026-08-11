import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Dashboard from "./dashboard";

export const dynamic = "force-dynamic";

export default async function PainelPage() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");

  const [{ data: profile }, { data: roles }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
    supabase.from("user_roles").select("organization_id,role").eq("user_id", userId),
  ]);

  const managerRole = roles?.find((item) => item.role === "admin") || roles?.find((item) => item.role === "organizer");
  const isJudge = roles?.some((item) => item.role === "judge");

  if (!managerRole && isJudge) redirect("/avaliar");
  if (!managerRole) redirect("/entrar?erro=sem-acesso");

  const { data: events } = await supabase
    .from("events")
    .select("id,name,edition,city,venue,status,starts_at,created_at,competitions(id,categories(id)),rings(id,name,status)")
    .eq("organization_id", managerRole.organization_id)
    .order("starts_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  return <Dashboard name={profile?.full_name || "Administrador"} role={managerRole.role} events={events || []} />;
}
