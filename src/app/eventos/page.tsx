import Link from "next/link";
import { CalendarDays, ChevronRight, Plus } from "lucide-react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const statusName: Record<string, string> = { draft: "Rascunho", registration_open: "Inscrições abertas", registration_closed: "Inscrições encerradas", preparing: "Preparação", live: "Em andamento", finished: "Finalizado", archived: "Arquivado" };
type Event = { id: string; name: string; edition: string | null; starts_at: string | null; city: string | null; status: string; competitions: Array<{ name: string }> };

function EventRows({ events }: { events: Event[] }) {
  return <div className="management-list">{events.map((event) => <Link href={`/eventos/${event.id}`} className="management-row" key={event.id}>
    <div className="row-icon"><CalendarDays /></div><div>
      <strong>{event.name}{event.edition ? ` · ${event.edition}` : ""}</strong>
      <span>{event.starts_at ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(event.starts_at)) : "Data a definir"}{event.city ? ` · ${event.city}` : ""}</span>
      <small>{event.competitions?.map((item) => item.name).join(" + ") || "Sem competições configuradas"}</small>
    </div><b>{statusName[event.status] || event.status}</b><ChevronRight />
  </Link>)}</div>;
}
export default async function EventosPage() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");
  const { data: roles, error: roleError } = await supabase.from("user_roles").select("organization_id,role").eq("user_id", userId);
  if (roleError) throw new Error("Não foi possível carregar as permissões.");
  const managerRole = roles?.find((role) => role.role === "admin") || roles?.find((role) => role.role === "organizer");
  if (!managerRole) redirect(roles?.some((role) => role.role === "judge") ? "/avaliar" : "/painel");
  const { data, error } = await supabase.from("events").select("id,name,edition,starts_at,city,status,competitions(name)")
    .eq("organization_id", managerRole.organization_id).order("starts_at", { ascending: false });
  if (error) throw new Error("Não foi possível carregar os eventos.");
  const events = (data || []) as Event[];
  const current = events.filter((event) => !["finished", "archived"].includes(event.status));
  const past = events.filter((event) => ["finished", "archived"].includes(event.status));
  return <main className="management-page"><div className="management-top"><div><span className="eyebrow">GESTÃO</span><h1>Eventos</h1><p>Organize jogos e apresentações, juntos ou em eventos separados.</p></div><Link className="primary" href="/eventos/novo"><Plus />Novo evento</Link></div>
    <h2>Eventos atuais e próximos</h2>
    {current.length ? <EventRows events={current} /> : <div className="empty-state"><CalendarDays /><h2>Nenhum evento atual</h2><p>Crie um novo evento. Os eventos já realizados continuam no histórico abaixo.</p><Link className="primary" href="/eventos/novo"><Plus />Criar evento</Link></div>}
    <details id="historico" className="event-history"><summary>Eventos já realizados ({past.length})</summary>
      <p>Consulte os resultados, as informações registradas e os relatórios dos eventos encerrados.</p>
      {past.length ? <EventRows events={past} /> : <p>Nenhum evento finalizado ou arquivado.</p>}
    </details>
    <Link className="back-link" href="/painel">← Voltar para visão geral</Link>
  </main>;
}
