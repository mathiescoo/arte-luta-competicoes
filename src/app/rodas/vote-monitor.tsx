"use client";

import { useMemo, useState } from "react";
import { Check, RefreshCw, Scale, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Match = { id: string; category_id: string; ring_id: string; blue_registration_id: string; green_registration_id: string; status: string; phase: string; winner_registration_id: string | null };
type Registration = { id: string; participants: { full_name: string }[] | null };
type Vote = { match_id: string; judge_id: string };
type Assignment = { event_id: string; competition_id: string; category_id: string | null; ring_id: string | null; judge_id: string; active: boolean };
type Event = { id: string; competitions: Array<{ id: string; model: "digital_flags" | "sum_score"; categories: Array<{ id: string }> }> };

export default function VoteMonitor({ initialEvents, initialMatches, initialRegistrations, initialVotes, initialAssignments }: {
  initialEvents: Event[];
  initialMatches: Match[];
  initialRegistrations: Registration[];
  initialVotes: Vote[];
  initialAssignments: Assignment[];
}) {
  const [matches, setMatches] = useState(initialMatches);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");

  const categoryCompetition = useMemo(() => {
    const map = new Map<string, { eventId: string; competitionId: string }>();
    for (const event of initialEvents) {
      for (const competition of event.competitions.filter((item) => item.model === "digital_flags")) {
        for (const category of competition.categories) map.set(category.id, { eventId: event.id, competitionId: competition.id });
      }
    }
    return map;
  }, [initialEvents]);

  const person = (id: string) => initialRegistrations.find((item) => item.id === id)?.participants?.[0]?.full_name || "Participante";
  const activeMatches = matches.filter((item) => item.status === "live");

  function assignedJudgeCount(match: Match) {
    const context = categoryCompetition.get(match.category_id);
    if (!context) return 0;
    return new Set(initialAssignments.filter((assignment) => assignment.active
      && assignment.event_id === context.eventId
      && assignment.competition_id === context.competitionId
      && assignment.ring_id === match.ring_id
      && (!assignment.category_id || assignment.category_id === match.category_id))
      .map((assignment) => assignment.judge_id)).size;
  }

  async function confirm(match: Match) {
    setLoading(match.id);
    setError("");
    const { data, error: finalizeError } = await createClient().rpc("finalize_match", { target_match: match.id });
    if (finalizeError) {
      setError(finalizeError.message);
      setLoading("");
      return;
    }
    const result = Array.isArray(data) ? data[0] : data;
    setMatches((items) => items.map((item) => item.id === match.id
      ? { ...item, status: "finished", winner_registration_id: result?.winner_registration_id || null }
      : item));
    setLoading("");
  }

  return (
    <section className="vote-monitor">
      <div className="vote-monitor-head">
        <div><span className="eyebrow">APURAÇÃO EM TEMPO REAL</span><h2>Votos dos juízes</h2></div>
        <button className="secondary" onClick={() => window.location.reload()}><RefreshCw />Atualizar</button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {activeMatches.length ? <div className="vote-monitor-list">{activeMatches.map((match) => {
        const expected = assignedJudgeCount(match);
        const received = new Set(initialVotes.filter((vote) => vote.match_id === match.id).map((vote) => vote.judge_id)).size;
        const ready = expected >= 3 && received === expected;
        return (
          <article key={match.id}>
            <div>
              <span>{match.phase}</span>
              <strong>{person(match.blue_registration_id)} <i>×</i> {person(match.green_registration_id)}</strong>
              <small className="vote-progress"><Users />{received} de {expected || "—"} votos recebidos</small>
            </div>
            <div>
              {ready
                ? <button className="primary" disabled={loading === match.id} onClick={() => confirm(match)}><Check />{loading === match.id ? "Confirmando..." : "Confirmar resultado"}</button>
                : <small><Scale />{expected < 3 ? "Designe ao menos 3 juízes" : "Aguardando todos os juízes"}</small>}
            </div>
          </article>
        );
      })}</div> : <div className="vote-monitor-empty"><Scale /><span>Nenhum confronto em votação agora.</span></div>}
    </section>
  );
}
