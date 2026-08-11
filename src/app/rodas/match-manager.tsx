"use client";

import { FormEvent, useState } from "react";
import { Play, Plus, Scale, Trophy, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type EventItem = { id: string; name: string; rings: Array<{ id: string; name: string }>; competitions: Array<{ id: string; name: string; model: "digital_flags" | "sum_score"; categories: Array<{ id: string; name: string }> }> };
type Registration = { id: string; event_id: string; category_id: string; participants: { full_name: string }[] | null };
type Match = { id: string; category_id: string; ring_id: string; blue_registration_id: string; green_registration_id: string; phase: string; status: string; winner_registration_id: string | null; started_at: string | null; finished_at: string | null };

export default function MatchManager({ initialEvents, initialRegistrations, initialMatches }: { initialEvents: EventItem[]; initialRegistrations: Registration[]; initialMatches: Match[] }) {
  const [eventId, setEventId] = useState(initialEvents[0]?.id || "");
  const [categoryId, setCategoryId] = useState("");
  const [matches, setMatches] = useState(initialMatches);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const event = initialEvents.find((item) => item.id === eventId);
  const categories = event?.competitions.filter((competition) => competition.model === "digital_flags").flatMap((competition) => competition.categories.map((category) => ({ ...category, competition: competition.name }))) || [];
  const activeCategory = categoryId || categories[0]?.id || "";
  const registrations = initialRegistrations.filter((item) => item.event_id === eventId && item.category_id === activeCategory);
  const categoryMatches = matches.filter((item) => item.category_id === activeCategory);
  const person = (registrationId: string) => initialRegistrations.find((item) => item.id === registrationId)?.participants?.[0]?.full_name || "Participante";

  async function createMatch(eventSubmit: FormEvent<HTMLFormElement>) {
    eventSubmit.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(eventSubmit.currentTarget);
    const blue = String(form.get("blue") || "");
    const green = String(form.get("green") || "");
    const ring = String(form.get("ring") || "");
    if (!activeCategory || !ring || !blue || !green || blue === green) {
      setError("Selecione a roda e dois participantes diferentes.");
      setLoading(false);
      return;
    }
    const { data, error: insertError } = await createClient().from("matches").insert({
      category_id: activeCategory, ring_id: ring, blue_registration_id: blue, green_registration_id: green,
      phase: String(form.get("phase") || "Eliminatória"), status: "waiting",
    }).select("id,category_id,ring_id,blue_registration_id,green_registration_id,phase,status,winner_registration_id,started_at,finished_at").single();
    if (insertError || !data) {
      setError(insertError?.message || "Não foi possível criar o confronto.");
      setLoading(false);
      return;
    }
    setMatches((items) => [...items, data as Match]);
    setOpen(false);
    setLoading(false);
  }

  async function startMatch(match: Match) {
    setLoading(true);
    setError("");
    const payload = { status: "live", started_at: new Date().toISOString() };
    const { error: updateError } = await createClient().from("matches").update(payload).eq("id", match.id);
    if (updateError) setError(updateError.message);
    else setMatches((items) => items.map((item) => item.id === match.id ? { ...item, ...payload } : item));
    setLoading(false);
  }

  return <section className="match-workspace">
    <div className="match-heading"><div><span className="eyebrow">CONFRONTOS</span><h2>Fila de disputas</h2></div><button className="primary" onClick={() => setOpen(true)} disabled={!event?.rings.length || registrations.length < 2}><Plus />Novo confronto</button></div>
    <div className="match-filters"><label>Evento<select value={eventId} onChange={(eventChange) => { setEventId(eventChange.target.value); setCategoryId(""); }}>{initialEvents.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Categoria<select value={activeCategory} onChange={(eventChange) => setCategoryId(eventChange.target.value)}>{categories.map((category) => <option value={category.id} key={category.id}>{category.competition} · {category.name}</option>)}</select></label></div>
    {error && <div className="form-error">{error}</div>}
    {!event?.rings.length ? <div className="empty-state compact"><Trophy /><h2>Crie uma roda primeiro</h2><p>O confronto precisa estar ligado a uma roda do evento.</p></div>
      : !categories.length ? <div className="empty-state compact"><Trophy /><h2>Nenhuma categoria de bandeiras configurada</h2><p>Cadastre categorias no Campeonato Interno ou Festival Mirim antes de criar confrontos.</p></div>
        : categoryMatches.length ? <div className="match-list">{categoryMatches.map((match) => <article key={match.id}><div className="match-meta"><span>{match.phase}</span><b>{event.rings.find((ring) => ring.id === match.ring_id)?.name || "Roda"}</b></div><div className="match-athletes"><strong className={match.winner_registration_id === match.blue_registration_id ? "winner blue" : "blue"}>{person(match.blue_registration_id)}</strong><i>×</i><strong className={match.winner_registration_id === match.green_registration_id ? "winner green" : "green"}>{person(match.green_registration_id)}</strong></div><div className="match-actions">{match.status === "waiting" && <button className="primary" disabled={loading} onClick={() => startMatch(match)}><Play />Iniciar</button>}{match.status === "live" && <small><Scale />Aguardando apuração dos juízes</small>}{match.status === "finished" && <small><Trophy />Finalizado</small>}</div></article>)}</div>
          : <div className="empty-state compact"><Trophy /><h2>Nenhum confronto nesta categoria</h2><p>Monte a primeira disputa com os participantes inscritos.</p></div>}
    {open && <div className="modal-wrap"><button className="backdrop" onClick={() => setOpen(false)} aria-label="Fechar" /><form className="modal category-modal" onSubmit={createMatch}><button type="button" className="modal-x" onClick={() => setOpen(false)}><X /></button><span className="eyebrow">{event?.name}</span><h2>Novo confronto</h2><div className="form-grid"><label>Roda<select name="ring" required><option value="">Selecione...</option>{event?.rings.map((ring) => <option value={ring.id} key={ring.id}>{ring.name}</option>)}</select></label><label>Fase<input name="phase" defaultValue="Eliminatória" /></label><label className="wide">Competidor azul<select name="blue" required><option value="">Selecione...</option>{registrations.map((registration) => <option value={registration.id} key={registration.id}>{person(registration.id)}</option>)}</select></label><label className="wide">Competidor verde<select name="green" required><option value="">Selecione...</option>{registrations.map((registration) => <option value={registration.id} key={registration.id}>{person(registration.id)}</option>)}</select></label></div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancelar</button><button className="primary" disabled={loading}>{loading ? "Criando..." : "Criar confronto"}</button></div></form></div>}
  </section>;
}
