import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CalendarDays, MapPin } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import CategoryManager from "./category-manager";
import EventSettings from "./event-settings";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");

  const { data: roles } = await supabase.from("user_roles").select("organization_id,role").eq("user_id", userId);
  const managerRole = roles?.find((role) => role.role === "admin") || roles?.find((role) => role.role === "organizer");
  if (!managerRole) redirect(roles?.some((role) => role.role === "judge") ? "/avaliar" : "/painel");

  const { data: event } = await supabase
    .from("events")
    .select("id,name,edition,starts_at,city,venue,status,settings,competitions(id,name,model,status,categories(id,name,code,status,sort_order,settings))")
    .eq("id", id)
    .eq("organization_id", managerRole.organization_id)
    .maybeSingle();
  if (!event) notFound();

  const competitions = (event.competitions || []) as Array<{ id: string; name: string; model: string; status: string; categories: Array<{ id: string; name: string; code: string | null; status: string; sort_order: number; settings: Record<string, unknown> }> }>;
  const hasScoringCompetition = competitions.some((competition) => competition.model === "sum_score");
  return <main className="management-page"><Link href="/eventos" className="back-link">← Voltar para eventos</Link><div className="event-detail-head"><div><span className="eyebrow">EVENTO · {event.status === "draft" ? "RASCUNHO" : event.status}</span><h1>{event.name}</h1><p>{event.edition || "Edição não informada"}</p></div><EventSettings eventId={event.id} initialSettings={(event.settings || {}) as Record<string, unknown>} initialStatus={event.status} /></div><div className="event-summary"><span><CalendarDays />{event.starts_at ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(event.starts_at)) : "Data a definir"}</span><span><MapPin />{[event.venue, event.city].filter(Boolean).join(" · ") || "Local a definir"}</span></div><nav className="event-tabs"><span className="active">Categorias</span><Link href={`/eventos/${id}/juizes`}>Juízes e rodas</Link>{hasScoringCompetition && <Link href="/pontuacao">Notas e apresentações</Link>}<Link href="/participantes">Participantes</Link><Link href="/resultados">Resultados</Link></nav><CategoryManager eventId={event.id} initialCompetitions={competitions} /></main>;
}
