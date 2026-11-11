import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CalendarDays, MapPin } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import CategoryManager from "./category-manager";
import EventSettings from "./event-settings";
import RegistrationFormManager from "./registration-form-manager";
import EventClosure from "./event-closure";
import EventHistory from "./event-history";
import type { Snapshot } from "@/lib/event-report-pdf";

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

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id,name,edition,starts_at,city,venue,status,settings,competitions(id,name,model,status,categories(id,name,code,status,sort_order,settings))")
    .eq("id", id)
    .eq("organization_id", managerRole.organization_id)
    .maybeSingle();
  if (eventError) throw new Error("Não foi possível carregar o evento.");
  if (!event) notFound();
  const { data: hasReport, error: reportError } = await supabase.rpc("event_closure_report_exists", { target_event: id });

  const competitions = (event.competitions || []) as Array<{ id: string; name: string; model: string; status: string; categories: Array<{ id: string; name: string; code: string | null; status: string; sort_order: number; settings: Record<string, unknown> }> }>;
  const hasScoringCompetition = competitions.some((competition) => competition.model === "sum_score");
  const hasGames = competitions.some((competition) => competition.model === "digital_flags");
  if (["finished", "archived"].includes(event.status)) {
    const { data: report, error: historyError } = hasReport ? await supabase.rpc("get_event_closure_report", { target_event: id }) : { data: null, error: null };
    return <main className="management-page"><Link href="/eventos#historico" className="back-link">← Voltar para eventos realizados</Link>
      <div className="event-detail-head"><div><span className="eyebrow">EVENTO JÁ REALIZADO</span><h1>{event.name}</h1><p>{event.edition || ""}</p></div></div>
      <div className="event-closed-notice">Este evento não aparece mais na operação. Seus resultados e registros foram preservados para consulta.</div>
      {historyError || reportError ? <p role="alert">Não foi possível carregar o histórico. Confira a conexão e tente novamente.</p> : report?.snapshot ? <EventHistory eventId={id} snapshot={report.snapshot as Snapshot} /> : <><p>Este evento ainda não possui um relatório de encerramento salvo. Os dados anteriores não foram apagados.</p>{event.status === "finished" && <EventClosure eventId={id} eventName={event.name} hasReport={false} existingFinished />}</>}
    </main>;
  }
  return <main className="management-page"><Link href="/eventos" className="back-link">← Voltar para eventos</Link><div className="event-detail-head"><div><span className="eyebrow">EVENTO · {event.status === "draft" ? "RASCUNHO" : event.status}</span><h1>{event.name}</h1><p>{event.edition || "Edição não informada"}</p></div><EventSettings eventId={event.id} initialSettings={(event.settings || {}) as Record<string, unknown>} initialStatus={event.status} /></div><div className="event-summary"><span><CalendarDays />{event.starts_at ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(event.starts_at)) : "Data a definir"}</span><span><MapPin />{[event.venue, event.city].filter(Boolean).join(" · ") || "Local a definir"}</span></div><nav className="event-tabs"><span className="active">Categorias</span><Link href={`/eventos/${id}/juizes`}>{hasGames ? "Juízes e rodas" : "Juízes"}</Link>{hasGames && <Link href="/rodas">Jogos e bandeiras</Link>}{hasScoringCompetition && <Link href="/pontuacao">Notas e apresentações</Link>}<Link href="/participantes">Participantes</Link><Link href="/resultados">Resultados</Link></nav><CategoryManager eventId={event.id} initialCompetitions={competitions} /><RegistrationFormManager eventId={event.id} closed={event.status === "finished"} />{reportError ? <p role="alert">Não foi possível verificar o relatório de encerramento.</p> : <EventClosure eventId={event.id} eventName={event.name} hasReport={Boolean(hasReport)} />}</main>;
}
