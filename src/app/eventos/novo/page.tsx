"use client";

import { type FormEvent, useState } from "react";
import { ArrowLeft, CalendarDays, Check, Music2, Shield, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const choices = [
  { id: "internal", name: "Campeonato Interno", description: "Confrontos por bandeiras digitais, chaves e rodas.", icon: Shield },
  { id: "mirim", name: "Festival Mirim", description: "Festival infantil com categorias e premiações próprias.", icon: Sparkles },
  { id: "musicality", name: "Cante Comigo Capoeira Intérpretes", description: "Apresentações avaliadas por somatório de notas.", icon: Music2 },
] as const;

export default function NovoEventoPage() {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function toggle(id: string) {
    setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected.length) {
      setError("Selecione pelo menos uma competição.");
      return;
    }

    setLoading(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    const { data: eventId, error: createError } = await createClient().rpc("create_event_with_competitions", {
      event_name: name,
      event_edition: String(form.get("edition") || ""),
      event_starts_at: String(form.get("date") || "") || null,
      event_city: String(form.get("city") || ""),
      event_venue: String(form.get("venue") || ""),
      competition_templates: selected,
    });

    if (createError || !eventId) {
      if (createError?.code === "PGRST202") {
        setError("A atualização de criação de eventos ainda não foi aplicada no Supabase. Execute a migration 015 e tente novamente.");
      } else {
        setError(createError?.message || "Não foi possível criar o evento.");
      }
      setLoading(false);
      return;
    }

    router.push(`/eventos/${eventId}`);
    router.refresh();
  }

  return (
    <main className="management-page wizard-page">
      <Link href="/eventos" className="back-link"><ArrowLeft />Voltar para eventos</Link>
      <div className="wizard-heading">
        <span className="eyebrow">NOVO EVENTO · ETAPA 1</span>
        <h1>Como será este evento?</h1>
        <p>As competições são independentes. Se acontecerem no mesmo dia, selecione mais de uma para reuni-las no mesmo evento.</p>
      </div>
      <form onSubmit={submit}>
        <section className="form-section">
          <h2>Informações gerais</h2>
          <div className="form-grid">
            <label className="wide">Nome do evento<input name="name" required placeholder="Ex.: Encontro Arte-Luta Brasil 2027" /></label>
            <label>Edição<input name="edition" placeholder="Ex.: 5ª edição" /></label>
            <label>Data<input name="date" type="date" /></label>
            <label>Cidade<input name="city" placeholder="São Paulo" /></label>
            <label>Local<input name="venue" placeholder="Ginásio ou endereço" /></label>
          </div>
        </section>

        <section className="form-section">
          <div className="choice-title">
            <div><h2>Selecione as competições</h2><p>Você pode marcar uma, duas ou todas.</p></div>
            <CalendarDays />
          </div>
          <div className="competition-choices">
            {choices.map((choice) => {
              const Icon = choice.icon;
              const active = selected.includes(choice.id);
              return (
                <button type="button" className={active ? "selected" : ""} onClick={() => toggle(choice.id)} key={choice.id}>
                  <span className="choice-check">{active && <Check />}</span>
                  <Icon /><strong>{choice.name}</strong><small>{choice.description}</small>
                </button>
              );
            })}
          </div>
          <div className="selection-note">
            {selected.includes("internal") && selected.includes("mirim")
              ? "Campeonato Interno e Festival Mirim acontecerão juntos neste evento, mantendo categorias e resultados separados."
              : selected.length ? `${selected.length} competição(ões) selecionada(s).` : "Nenhuma competição selecionada."}
          </div>
        </section>
        {error && <div className="form-error">{error}</div>}
        <div className="wizard-actions">
          <Link href="/eventos" className="secondary">Cancelar</Link>
          <button className="primary" disabled={loading}>{loading ? "Criando..." : "Criar evento e continuar"}</button>
        </div>
      </form>
    </main>
  );
}
