import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ResultsManager from "./results-manager";

export const dynamic = "force-dynamic";

export default async function ResultsPage() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");

  const { data: roles } = await supabase.from("user_roles").select("organization_id,role").eq("user_id", userId);
  const managerRole = roles?.find((role) => role.role === "admin") || roles?.find((role) => role.role === "organizer");
  if (!managerRole) redirect(roles?.some((role) => role.role === "judge") ? "/avaliar" : "/painel");

  const { data: events } = await supabase
    .from("events")
    .select("id,name,competitions(id,name,model,categories(id,name))")
    .eq("organization_id", managerRole.organization_id)
    .neq("status", "archived")
    .order("created_at", { ascending: false });
  const eventIds = (events || []).map((event) => event.id);
  const categoryIds = (events || []).flatMap((event) => event.competitions.flatMap((competition) => competition.categories.map((category) => category.id)));
  const [registrationsResult, resultsResult] = await Promise.all([
    eventIds.length ? supabase.from("registrations").select("id,event_id,category_id,participants(full_name)").in("event_id", eventIds) : Promise.resolve({ data: [] }),
    categoryIds.length ? supabase.from("results").select("id,category_id,registration_id,position,total,published_at,homologated_at").in("category_id", categoryIds).order("position", { ascending: true, nullsFirst: false }) : Promise.resolve({ data: [] }),
  ]);

  return <main className="management-page"><Link href="/painel" className="back-link">← Voltar para visão geral</Link><div className="management-top"><div><span className="eyebrow">RESULTADOS</span><h1>Classificações e pódios</h1><p>Registre a posição final, confira a classificação e publique quando tudo estiver homologado.</p></div></div><ResultsManager initialEvents={events || []} initialRegistrations={registrationsResult.data || []} initialResults={resultsResult.data || []} /></main>;
}
