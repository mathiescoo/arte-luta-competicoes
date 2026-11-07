"use client";

import { useEffect, useState } from "react";
import { Check, RefreshCw, Scale, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { participantName, type ParticipantRelation } from "@/lib/participant-relation";

type Match = { id: string; category_id: string; ring_id: string; blue_registration_id: string; green_registration_id: string; status: string; phase: string; winner_registration_id: string | null };
type Registration = { id: string; participants: ParticipantRelation };
type Vote = { match_id: string; judge_id: string };
type Assignment = { event_id: string; competition_id: string; category_id: string | null; ring_id: string | null; judge_id: string; active: boolean };
type Event = { id: string; competitions: Array<{ id: string; model: "digital_flags" | "sum_score"; categories: Array<{ id: string }> }> };

export default function VoteMonitor({ initialMatches, initialRegistrations, initialVotes }: {
  initialEvents: Event[];
  initialMatches: Match[];
  initialRegistrations: Registration[];
  initialVotes: Vote[];
  initialAssignments: Assignment[];
}) {
  const [matches, setMatches] = useState(initialMatches);
  const [votes, setVotes] = useState(initialVotes);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");

  const person = (id: string) => participantName(initialRegistrations.find((item) => item.id === id)?.participants || null);
  const activeMatches = matches.filter((item) => item.status === "live");

  useEffect(() => {
    const ids = initialMatches.filter((match) => match.status === "live").map((match) => match.id);
    if (!ids.length) return;
    let active = true;
    const refresh = async () => {
      const { data } = await createClient().from("flag_votes").select("match_id,judge_id").in("match_id", ids);
      if (active && data) setVotes(data);
    };
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [initialMatches]);

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
        const expected = 3;
        const received = new Set(votes.filter((vote) => vote.match_id === match.id).map((vote) => vote.judge_id)).size;
        const ready = received === expected;
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
                : <small><Scale />Aguardando os três juízes</small>}
            </div>
          </article>
        );
      })}</div> : <div className="vote-monitor-empty"><Scale /><span>Nenhum confronto em votação agora.</span></div>}
    </section>
  );
}
