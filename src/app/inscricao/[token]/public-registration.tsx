"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Field = { key: string; label: string; type: "text" | "number" | "date" | "select"; required: boolean; options?: string[] };
type Category = { id: string; name: string; competition: string; model: "sum_score" | "digital_flags" };
type Form = { event: { name: string; starts_at: string | null; venue: string | null; city: string | null }; categories: Category[]; fields: Field[]; taken_songs: string[] };

export default function PublicRegistration({ token, form }: { token: string; form: Form }) {
  const router = useRouter();
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  const category = form.categories.find((item) => item.id === categoryId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const fields = new FormData(event.currentTarget);
    const data: Record<string, string> = { age: String(fields.get("age") || "") };
    for (const field of form.fields) data[field.key] = String(fields.get(field.key) || "");
    if (category?.model === "sum_score") { data.song_title = String(fields.get("song_title") || ""); data.song_author = String(fields.get("song_author") || ""); }
    setBusy(true);
    const { error: submitError } = await createClient().rpc("submit_public_registration", { form_token: token, target_category: categoryId, participant_name: String(fields.get("full_name") || ""), supplied_data: data });
    setBusy(false);
    if (submitError) {
      setError(/song already selected/i.test(submitError.message) ? "Esta música já foi escolhida. Selecione outra." : /registration is not open/i.test(submitError.message) ? "As inscrições foram encerradas." : "Não foi possível enviar a inscrição. Confira os dados e tente novamente.");
      router.refresh();
    } else setComplete(true);
  }
  return <main className="management-page"><h1>{form.event.name}</h1><p>{[form.event.venue, form.event.city].filter(Boolean).join(" · ")}</p>
    {complete ? <section className="empty-state compact"><h2>Inscrição enviada</h2><p>A organização recebeu seus dados.</p></section> : <form className="form-section public-registration-form" onSubmit={(event) => void submit(event)}>
      <h2>Inscrição</h2><div className="form-grid"><label className="wide">Nome completo<input name="full_name" required minLength={2} maxLength={150} /></label><label>Idade<input name="age" type="number" min="0" max="130" required /></label>
      <label>Categoria<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required><option value="">Selecione</option>{form.categories.map((item) => <option key={item.id} value={item.id}>{item.competition} · {item.name}</option>)}</select></label>
      {category?.model === "sum_score" && <><div className="wide"><strong>Músicas já escolhidas</strong><p>{form.taken_songs.length ? form.taken_songs.join(" · ") : "Nenhuma música foi escolhida ainda."}</p></div><label className="wide">Música que vai cantar<input name="song_title" required maxLength={250} /></label><label className="wide">Autor ou intérprete<input name="song_author" required maxLength={250} /></label></>}
      {form.fields.map((field) => <label className="wide" key={field.key}>{field.label}{field.type === "select" ? <select name={field.key} required={field.required}><option value="">Selecione</option>{(field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input name={field.key} type={field.type} required={field.required} maxLength={field.type === "text" ? 500 : undefined} />}</label>)}</div>
      {error && <div className="form-error" role="alert">{error}</div>}<button className="primary" disabled={busy || !categoryId}>{busy ? "Enviando..." : "Enviar inscrição"}</button>
    </form>}
  </main>;
}
