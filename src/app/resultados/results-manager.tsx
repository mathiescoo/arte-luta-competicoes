"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { Award, Check, Music2, Plus, Send, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { participantName as nameForParticipant, type ParticipantRelation } from "@/lib/participant-relation";

type Category = { id: string; name: string };
type EventItem = { id: string; name: string; competitions: Array<{ id: string; name: string; model: "digital_flags" | "sum_score"; categories: Category[] }> };
type Registration = { id: string; event_id: string; category_id: string; participants: ParticipantRelation };
type Result = { id: string; category_id: string; registration_id: string; position: number | null; total: number | null; published_at: string | null; homologated_at: string | null };

export default function ResultsManager({ initialEvents, initialRegistrations, initialResults }: { initialEvents: EventItem[]; initialRegistrations: Registration[]; initialResults: Result[] }) {
  const [eventId, setEventId] = useState(initialEvents[0]?.id || "");
  const [categoryId, setCategoryId] = useState("");
  const [results, setResults] = useState(initialResults);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const event = initialEvents.find((item) => item.id === eventId);
  const categories = event?.competitions.flatMap((competition) => competition.categories.map((category) => ({ ...category, competition: competition.name, model: competition.model }))) || [];
  const currentCategoryId = categoryId || categories[0]?.id || "";
  const activeCategory = categories.find((item) => item.id === currentCategoryId);
  const isScoring = activeCategory?.model === "sum_score";
  const registrations = initialRegistrations.filter((item) => item.event_id === eventId && item.category_id === currentCategoryId);
  const categoryResults = results.filter((item) => item.category_id === currentCategoryId).sort((a, b) => (a.position || 999) - (b.position || 999));
  const participantName = (registrationId: string) => nameForParticipant(initialRegistrations.find((item) => item.id === registrationId)?.participants || null);
  const published = categoryResults.length > 0 && categoryResults.every((item) => item.published_at);

  async function saveResult(eventSubmit: FormEvent<HTMLFormElement>) {
    eventSubmit.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(eventSubmit.currentTarget);
    const registrationId = String(form.get("registration_id") || "");
    const position = Number(form.get("position"));
    const totalValue = String(form.get("total") || "");
    if (!currentCategoryId || !registrationId || !Number.isInteger(position) || position < 1) {
      setError("Informe participante e posição válida.");
      setLoading(false);
      return;
    }
    if (categoryResults.some((item) => item.position === position && item.registration_id !== registrationId)) {
      setError("Essa posição já foi atribuída a outro participante.");
      setLoading(false);
      return;
    }
    const total = totalValue ? Number(totalValue) : null;
    if (total !== null && (!Number.isFinite(total) || total < 0)) {
      setError("Informe uma pontuação válida ou deixe o campo vazio.");
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const existing = results.find((item) => item.category_id === currentCategoryId && item.registration_id === registrationId);
    const payload = { position, total, homologated_at: new Date().toISOString(), published_at: null };
    const query = existing ? supabase.from("results").update(payload).eq("id", existing.id).select("id,category_id,registration_id,position,total,published_at,homologated_at").single() : supabase.from("results").insert({ ...payload, category_id: currentCategoryId, registration_id: registrationId }).select("id,category_id,registration_id,position,total,published_at,homologated_at").single();
    const { data, error: saveError } = await query;
    if (saveError || !data) {
      setError(saveError?.message || "Não foi possível salvar o resultado.");
      setLoading(false);
      return;
    }
    setResults((items) => existing ? items.map((item) => item.id === existing.id ? data as Result : item) : [...items, data as Result]);
    setOpen(false);
    setLoading(false);
  }

  async function togglePublication() {
    if (!categoryResults.length) return;
    if (!published) {
      if (categoryResults.length !== registrations.length) {
        setError("Registre a classificação de todos os inscritos antes de publicar.");
        return;
      }
      if (categoryResults.some((item) => !item.homologated_at || !item.position)) {
        setError("Todos os resultados precisam estar homologados antes da publicação.");
        return;
      }
      if (new Set(categoryResults.map((item) => item.position)).size !== categoryResults.length) {
        setError("Não é possível publicar com posições duplicadas.");
        return;
      }
    }
    setLoading(true);
    setError("");
    const publishedAt = published ? null : new Date().toISOString();
    const { error: updateError } = await createClient().from("results").update({ published_at: publishedAt }).eq("category_id", currentCategoryId);
    if (updateError) setError(updateError.message);
    else setResults((items) => items.map((item) => item.category_id === currentCategoryId ? { ...item, published_at: publishedAt } : item));
    setLoading(false);
  }

  return <section className="results-workspace"><div className="result-controls"><label>Evento<select value={eventId} onChange={(eventChange) => { setEventId(eventChange.target.value); setCategoryId(""); }}>{initialEvents.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Categoria<select value={currentCategoryId} onChange={(eventChange) => setCategoryId(eventChange.target.value)}>{categories.map((category) => <option value={category.id} key={category.id}>{category.competition} · {category.name}</option>)}</select></label>{isScoring ? <Link className="primary" href="/pontuacao"><Music2 />Calcular Cante Comigo</Link> : <button className="primary" onClick={() => setOpen(true)} disabled={!registrations.length}><Plus />Registrar resultado</button>}</div>{error && <div className="form-error">{error}</div>}{!initialEvents.length ? <div className="empty-state compact"><Award /><h2>Nenhum evento disponível</h2><p>Crie um evento, categorias e inscrições para registrar os resultados.</p></div> : !categories.length ? <div className="empty-state compact"><Award /><h2>Nenhuma categoria cadastrada</h2><p>Configure as categorias do evento antes de montar a classificação.</p></div> : <><div className="results-head"><div><span className="eyebrow">CLASSIFICAÇÃO ATUAL</span><h2>{activeCategory?.name}</h2></div>{categoryResults.length > 0 && <button className={published ? "secondary published" : "primary"} onClick={togglePublication} disabled={loading}>{published ? <><Check />Publicado</> : <><Send />Publicar resultado</>}</button>}</div>{categoryResults.length ? <div className="results-list">{categoryResults.map((result) => <article key={result.id}><strong>{result.position || "—"}º</strong><div><b>{participantName(result.registration_id)}</b><span>{result.total === null ? "Sem pontuação registrada" : `${result.total.toFixed(2)} pontos`}</span></div><small>{result.published_at ? "Publicado" : result.homologated_at ? "Homologado" : "Rascunho"}</small></article>)}</div> : <div className="empty-state compact"><Award /><h2>Classificação ainda vazia</h2><p>{isScoring ? "Conclua as apresentações e gere a classificação em Notas e apresentações." : registrations.length ? "Registre as posições finais dos participantes desta categoria." : "Ainda não há participantes inscritos nesta categoria."}</p></div>}</>}{open && <div className="modal-wrap"><button className="backdrop" onClick={() => setOpen(false)} aria-label="Fechar" /><form className="modal category-modal" onSubmit={saveResult}><button type="button" className="modal-x" onClick={() => setOpen(false)}><X /></button><span className="eyebrow">{event?.name}</span><h2>Registrar resultado</h2><div className="form-grid"><label className="wide">Participante<select name="registration_id" required><option value="">Selecione...</option>{registrations.map((registration) => <option key={registration.id} value={registration.id}>{participantName(registration.id)}</option>)}</select></label><label>Posição<input name="position" type="number" min="1" required /></label><label>Pontuação total<input name="total" type="number" min="0" step="0.01" placeholder="Opcional" /></label></div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancelar</button><button className="primary" disabled={loading}>{loading ? "Salvando..." : "Salvar resultado"}</button></div></form></div>}</section>;
}
