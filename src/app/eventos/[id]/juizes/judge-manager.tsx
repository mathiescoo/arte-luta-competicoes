"use client";

import { FormEvent, useMemo, useState } from "react";
import { Plus, UserRound, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Event = { id: string; name: string; competitions: Array<{ id: string; name: string; model: "digital_flags" | "sum_score"; categories: Array<{ id: string; name: string }> }>; rings: Array<{ id: string; name: string }> };
type Profile = { id: string; full_name: string };
type Relation<T> = T | T[] | null;
type Assignment = { id: string; judge_id: string; competition_id: string; category_id: string | null; ring_id: string | null; active: boolean; profiles: Relation<{ full_name: string }>; competitions: Relation<{ name: string }>; categories: Relation<{ name: string }>; rings: Relation<{ name: string }> };
function one<T>(value: Relation<T> | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }

export default function JudgeManager({ event, profiles, initialAssignments }: { event: Event; profiles: Profile[]; initialAssignments: Assignment[] }) {
  const [assignments, setAssignments] = useState(initialAssignments);
  const [open, setOpen] = useState(false);
  const [competitionId, setCompetitionId] = useState(event.competitions[0]?.id || "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const competition = event.competitions.find((item) => item.id === competitionId);
  const categories = useMemo(() => competition?.categories || [], [competition]);
  const needsRing = competition?.model === "digital_flags";
  const duplicateNames = new Set(profiles.filter((profile, index) => profiles.some((other, i) => i !== index && other.full_name.trim().toLocaleLowerCase("pt-BR") === profile.full_name.trim().toLocaleLowerCase("pt-BR"))).map((profile) => profile.id));

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(formEvent.currentTarget);
    const judgeId = String(form.get("judge_id") || "");
    const ringId = String(form.get("ring_id") || "") || null;
    const categoryId = String(form.get("category_id") || "") || null;
    if (!judgeId || !competitionId || !categoryId || (needsRing && !ringId)) {
      setError(needsRing ? "Selecione o juiz, a categoria e a roda para julgamento por bandeiras." : "Selecione o juiz e a categoria.");
      setLoading(false);
      return;
    }

    const supabase = createClient();
    const { error: eventUserError } = await supabase.from("event_users").upsert({ event_id: event.id, user_id: judgeId, role: "judge" }, { onConflict: "event_id,user_id,role" });
    if (eventUserError) {
      setError(eventUserError.message);
      setLoading(false);
      return;
    }
    const { data, error: assignmentError } = await supabase.from("judge_assignments").insert({ event_id: event.id, competition_id: competitionId, category_id: categoryId, ring_id: ringId, judge_id: judgeId, active: true }).select("id,judge_id,competition_id,category_id,ring_id,active,profiles(full_name),competitions(name),categories(name),rings(name)").single();
    if (assignmentError || !data) {
      setError(assignmentError?.message || "Não foi possível criar a designação.");
      setLoading(false);
      return;
    }
    setAssignments((items) => [...items, data as Assignment]);
    setOpen(false);
    setLoading(false);
  }

  async function deactivate(id: string) {
    setError(""); setLoading(true);
    try {
      const { data, error: updateError } = await createClient().from("judge_assignments").update({ active: false }).eq("id", id).select("id").single();
      if (updateError || !data) { setError("Não foi possível desativar a designação. Confira se há uma avaliação ou confronto em andamento."); return; }
      setAssignments((items) => items.map((item) => item.id === id ? { ...item, active: false } : item));
    } catch { setError("Falha de conexão. Atualize a página e confira a designação antes de tentar novamente."); }
    finally { setLoading(false); }
  }

  return <section className="judge-workspace"><div className="judge-actions"><span>{assignments.filter((item) => item.active).length} designação(ões) ativa(s)</span><button className="primary" onClick={() => setOpen(true)} disabled={!profiles.length}><Plus />Designar juiz</button></div>{error && !open && <div className="form-error" role="alert">{error}</div>}{assignments.length ? <div className="judge-list">{assignments.map((assignment) => <article key={assignment.id}><span className="person-dot"><UserRound /></span><div><strong>{one(assignment.profiles)?.full_name || profiles.find((profile) => profile.id === assignment.judge_id)?.full_name || `Juiz (${assignment.judge_id.slice(0, 8)})`}</strong><span>{one(assignment.competitions)?.name || "Competição"} · {one(assignment.categories)?.name || "Categoria"} · {one(assignment.rings)?.name || "Sem roda"}</span></div><b>{assignment.active ? "Ativo" : "Inativo"}</b>{assignment.active && <button disabled={loading} onClick={() => void deactivate(assignment.id)}>Desativar</button>}</article>)}</div> : <div className="empty-state compact"><UserRound /><h2>Nenhum juiz designado</h2><p>{profiles.length ? "Crie uma designação para liberar o painel individual do juiz." : "Libere as solicitações em ‘Liberação de juízes’ antes de designar alguém ao evento."}</p></div>}{open && <div className="modal-wrap"><button className="backdrop" onClick={() => setOpen(false)} aria-label="Fechar" /><form className="modal category-modal" onSubmit={submit}><button type="button" className="modal-x" onClick={() => setOpen(false)} aria-label="Fechar"><X /></button><span className="eyebrow">{event.name}</span><h2>Designar juiz</h2><div className="form-grid"><label className="wide">Juiz<select name="judge_id" required><option value="">Selecione...</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.full_name}{duplicateNames.has(profile.id) ? ` · ID ${profile.id.slice(0, 8)}` : ""}</option>)}</select></label><label className="wide">Competição<select value={competitionId} onChange={(eventChange) => setCompetitionId(eventChange.target.value)}>{event.competitions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Categoria<select name="category_id" required><option value="">Selecione...</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>{needsRing && <label>Roda<select name="ring_id" required><option value="">Selecione...</option>{event.rings.map((ring) => <option value={ring.id} key={ring.id}>{ring.name}</option>)}</select></label>}</div>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancelar</button><button className="primary" disabled={loading}>{loading ? "Salvando..." : "Salvar designação"}</button></div></form></div>}</section>;
}
