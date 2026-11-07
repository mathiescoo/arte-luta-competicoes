"use client";

import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./scoring.module.css";

type Criterion = { id: string; name: string; min_score: number; max_score: number };
type Card = { id: string; judge_name: string; note: string | null; scores: Record<string, number> };

export default function AdminScoreEditor({ presentationId, participantName, criteria, onClose, onSaved }: {
  presentationId: string; participantName: string; criteria: Criterion[]; onClose: () => void; onSaved: () => void;
}) {
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState("");
  const [scores, setScores] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    void createClient().rpc("scoring_presentation_scorecards", { target_presentation: presentationId }).then(({ data, error: requestError }) => {
      if (!active) return;
      if (requestError) setError(requestError.message);
      else setCards((data || []) as Card[]);
      setBusy(false);
    });
    return () => { active = false; };
  }, [presentationId]);

  function choose(id: string) {
    const card = cards.find((item) => item.id === id);
    setSelected(id);
    setScores(Object.fromEntries(criteria.map((criterion) => [criterion.id, String(card?.scores[criterion.id] ?? "")])));
    setNote(card?.note || "");
    setReason("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = criteria.map((criterion) => ({ criterion_id: criterion.id, score: Number((scores[criterion.id] || "").replace(",", ".")) }));
    if (!selected || reason.trim().length < 3 || criteria.some((criterion, index) => !scores[criterion.id]?.trim() || !Number.isFinite(values[index].score) || values[index].score < criterion.min_score || values[index].score > criterion.max_score)) {
      setError("Selecione a ficha, informe o motivo e confira as notas dentro dos limites de cada critério.");
      return;
    }
    setBusy(true);
    setError("");
    const { error: requestError } = await createClient().rpc("admin_adjust_scoring_scorecard", {
      target_scorecard: selected, submitted_scores: values, submitted_note: note, adjustment_reason: reason.trim(),
    });
    setBusy(false);
    if (requestError) setError(requestError.message);
    else { onSaved(); onClose(); }
  }

  return <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-labelledby="edit-scores-title">
    <button className={styles.modalBackdrop} type="button" onClick={onClose} aria-label="Fechar" />
    <form className={styles.criteriaModal} onSubmit={(event) => void save(event)}>
      <div className={styles.modalHeading}><div><span className="eyebrow">INTERVENÇÃO ADMINISTRATIVA</span><h2 id="edit-scores-title">Editar notas de {participantName}</h2><p>A alteração fica registrada com seu motivo. Uma classificação ainda não publicada precisará ser gerada novamente.</p></div></div>
      <label className={styles.noteField}>Ficha do jurado<select value={selected} onChange={(event) => choose(event.target.value)} required><option value="">Selecione o jurado</option>{cards.map((card) => <option key={card.id} value={card.id}>{card.judge_name}</option>)}</select></label>
      {!busy && !cards.length && <p>Nenhum jurado enviou ficha para esta apresentação.</p>}
      {selected && <><div className={styles.scoreInputs}>{criteria.map((criterion) => <label key={criterion.id}><span><strong>{criterion.name}</strong></span><input type="number" step="0.01" min={criterion.min_score} max={criterion.max_score} required value={scores[criterion.id] || ""} onChange={(event) => setScores((current) => ({ ...current, [criterion.id]: event.target.value }))} /><em>{criterion.min_score}–{criterion.max_score}</em></label>)}</div>
        <label className={styles.noteField}>Observação<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></label>
        <label className={styles.noteField}>Motivo da correção<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={500} required /></label></>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className={styles.modalActions}><span /><div><button type="button" className={styles.cancelButton} onClick={onClose}>Fechar</button><button className={styles.primaryButton} disabled={busy || !selected}>{busy ? "Aguarde..." : "Salvar correção"}</button></div></div>
    </form>
  </div>;
}
