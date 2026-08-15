import { redirect } from "next/navigation";
import Link from "next/link";
import { Music2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import RingManager from "./ring-manager";
import MatchManager from "./match-manager";
import VoteMonitor from "./vote-monitor";

export const dynamic = "force-dynamic";

export default async function RingsPage() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");

  const { data: roles } = await supabase
    .from("user_roles")
    .select("organization_id,role")
    .eq("user_id", userId);
  const managerRole = roles?.find((role) => role.role === "admin") || roles?.find((role) => role.role === "organizer");
  if (!managerRole) redirect(roles?.some((role) => role.role === "judge") ? "/avaliar" : "/painel");

  const { data: events } = await supabase
    .from("events")
    .select("id,name,status,rings(id,name,status,settings),competitions(id,name,model,categories(id,name))")
    .eq("organization_id", managerRole.organization_id)
    .neq("status", "archived")
    .order("created_at", { ascending: false });

  const allEvents = events || [];
  const fightEvents = allEvents
    .filter((event) => event.competitions.some((competition) => competition.model === "digital_flags"))
    .map((event) => ({ ...event, competitions: event.competitions.filter((competition) => competition.model === "digital_flags") }));
  const scoringEvents = allEvents.filter((event) => event.competitions.some((competition) => competition.model === "sum_score"));
  const eventIds = fightEvents.map((event) => event.id);
  const categoryIds = fightEvents.flatMap((event) => event.competitions.filter((competition) => competition.model === "digital_flags").flatMap((competition) => competition.categories.map((category) => category.id)));
  const matchesQuery = categoryIds.length
    ? supabase.from("matches").select("id,category_id,ring_id,blue_registration_id,green_registration_id,phase,status,winner_registration_id,started_at,finished_at").in("category_id", categoryIds).order("started_at", { ascending: false, nullsFirst: false })
    : Promise.resolve({ data: [] });

  const [registrationsResult, matchesResult, assignmentsResult] = await Promise.all([
    eventIds.length
      ? supabase.from("registrations").select("id,event_id,category_id,participants(full_name)").in("event_id", eventIds)
      : Promise.resolve({ data: [] }),
    matchesQuery,
    eventIds.length
      ? supabase.from("judge_assignments").select("event_id,competition_id,category_id,ring_id,judge_id,active").in("event_id", eventIds)
      : Promise.resolve({ data: [] }),
  ]);

  const matchIds = (matchesResult.data || []).map((match) => match.id);
  const { data: votes } = matchIds.length
    ? await supabase.from("flag_votes").select("match_id,judge_id").in("match_id", matchIds)
    : { data: [] };

  return (
    <main className="management-page">
      <Link href="/painel" className="back-link">← Voltar para visão geral</Link>
      <div className="management-top"><div><span className="eyebrow">OPERAÇÃO</span><h1>Controle das rodas</h1><p>Prepare as rodas, acompanhe os votos e registre cada resultado da disputa.</p></div></div>
      {scoringEvents.length > 0 && (
        <section className="empty-state compact">
          <Music2 />
          <h2>O Cante Comigo não usa rodas</h2>
          <p>Abra uma apresentação por vez em Notas e apresentações. As categorias, músicas e avaliações dos jurados ficam nesse painel.</p>
          <Link className="primary" href="/pontuacao">Abrir notas e apresentações</Link>
        </section>
      )}
      {fightEvents.length ? <>
        <RingManager initialEvents={fightEvents} />
        <MatchManager initialEvents={fightEvents} initialRegistrations={registrationsResult.data || []} initialMatches={matchesResult.data || []} />
        <VoteMonitor
          initialEvents={fightEvents}
          initialMatches={matchesResult.data || []}
          initialRegistrations={registrationsResult.data || []}
          initialVotes={votes || []}
          initialAssignments={assignmentsResult.data || []}
        />
      </> : !scoringEvents.length && <section className="empty-state compact"><Music2 /><h2>Nenhuma competição por bandeiras configurada</h2><p>Crie ou selecione Campeonato Interno ou Festival Mirim para operar rodas e confrontos.</p></section>}
    </main>
  );
}
