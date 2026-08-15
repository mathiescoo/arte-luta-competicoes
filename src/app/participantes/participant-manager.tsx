"use client";

import { FormEvent, useMemo, useState } from "react";
import { Plus, Search, UserRound, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type EventItem = {
  id: string;
  name: string;
  competitions: Array<{
    id: string;
    name: string;
    categories: Array<{ id: string; name: string }>;
  }>;
};

type Registration = {
  id: string;
  event_id: string;
  category_id: string;
  attendance_confirmed: boolean;
  payment_confirmed: boolean;
  data: Record<string, unknown>;
};

type Participant = {
  id: string;
  full_name: string;
  birth_date: string | null;
  private_data: Record<string, unknown>;
  registrations: Registration[];
};

function registrationAge(participant: Participant) {
  const savedAge = participant.registrations
    .map((registration) => registration.data?.age)
    .find((age) => typeof age === "string" && age.trim());

  if (typeof savedAge === "string") return savedAge;
  if (!participant.birth_date) return null;

  const birth = new Date(participant.birth_date);
  const today = new Date();
  let age = today.getFullYear() - birth.getUTCFullYear();
  const birthdayHasPassed = today.getMonth() > birth.getUTCMonth()
    || (today.getMonth() === birth.getUTCMonth() && today.getDate() >= birth.getUTCDate());
  if (!birthdayHasPassed) age -= 1;
  return String(Math.max(0, age));
}

function ageLabel(age: string) {
  return /\bano(?:s)?\b/i.test(age) ? age : `${age} anos`;
}

export default function ParticipantManager({
  organizationId,
  initialEvents,
  initialParticipants,
}: {
  organizationId: string;
  initialEvents: EventItem[];
  initialParticipants: Participant[];
}) {
  const [participants, setParticipants] = useState(initialParticipants);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [eventId, setEventId] = useState(initialEvents[0]?.id || "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const event = initialEvents.find((item) => item.id === eventId);
  const categories = event?.competitions.flatMap((competition) =>
    competition.categories.map((category) => ({ ...category, competition: competition.name })),
  ) || [];
  const filtered = useMemo(
    () => participants.filter((item) => item.full_name.toLowerCase().includes(query.toLowerCase())),
    [participants, query],
  );

  async function submit(eventSubmit: FormEvent<HTMLFormElement>) {
    eventSubmit.preventDefault();
    setLoading(true);
    setError("");

    const form = new FormData(eventSubmit.currentTarget);
    const categoryId = String(form.get("category_id") || "");
    if (!eventId || !categoryId) {
      setError("Selecione o evento e a categoria.");
      setLoading(false);
      return;
    }

    const age = String(form.get("age") || "").trim();
    const songTitle = String(form.get("song_title") || "").trim();
    const songAuthor = String(form.get("song_author") || "").trim();
    const payload = {
      organization_id: organizationId,
      full_name: String(form.get("full_name") || "").trim(),
      birth_date: String(form.get("birth_date") || "") || null,
      private_data: {
        phone: String(form.get("phone") || "").trim(),
        guardian: String(form.get("guardian") || "").trim(),
        school: String(form.get("school") || "").trim(),
        teacher: String(form.get("teacher") || "").trim(),
        graduation: String(form.get("graduation") || "").trim(),
        sex: String(form.get("sex") || "").trim(),
        notes: String(form.get("notes") || "").trim(),
      },
    };

    const supabase = createClient();
    const { data: participant, error: participantError } = await supabase
      .from("participants")
      .insert(payload)
      .select("id,full_name,birth_date,private_data")
      .single();

    if (participantError || !participant) {
      setError(participantError?.message || "Erro ao cadastrar participante.");
      setLoading(false);
      return;
    }

    const { data: registration, error: registrationError } = await supabase
      .from("registrations")
      .insert({
        event_id: eventId,
        participant_id: participant.id,
        category_id: categoryId,
        data: {
          source: "manual",
          age,
          song_title: songTitle,
          song_author: songAuthor,
        },
      })
      .select("id,event_id,category_id,attendance_confirmed,payment_confirmed,data")
      .single();

    if (registrationError || !registration) {
      setError("Participante criado, mas não foi possível concluir a inscrição.");
      setLoading(false);
      return;
    }

    setParticipants((items) => [
      ...items,
      { ...participant, registrations: [registration] } as Participant,
    ].sort((left, right) => left.full_name.localeCompare(right.full_name)));
    setOpen(false);
    setLoading(false);
  }

  return (
    <section className="participant-workspace">
      <div className="participant-tools">
        <label>
          <Search />
          <input value={query} onChange={(eventChange) => setQuery(eventChange.target.value)} placeholder="Buscar participante" />
        </label>
        <button className="primary" onClick={() => setOpen(true)}><Plus />Novo participante</button>
      </div>

      {filtered.length ? (
        <div className="participant-table">
          <div className="table-head"><span>Participante</span><span>Idade</span><span>Inscrições</span><span>Status</span></div>
          {filtered.map((participant) => {
            const age = registrationAge(participant);
            return (
              <article key={participant.id}>
                <div><span className="person-dot"><UserRound /></span><strong>{participant.full_name}</strong></div>
                <span>{age ? ageLabel(age) : "—"}</span>
                <span>{participant.registrations.length}</span>
                <b>Pendente</b>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state compact"><UserRound /><h2>Nenhum participante encontrado</h2><p>Cadastre manualmente ou importe a planilha do evento.</p></div>
      )}

      {open && (
        <div className="modal-wrap">
          <button className="backdrop" onClick={() => setOpen(false)} aria-label="Fechar" />
          <form className="modal category-modal" onSubmit={submit}>
            <button type="button" className="modal-x" onClick={() => setOpen(false)}><X /></button>
            <span className="eyebrow">CADASTRO MANUAL</span>
            <h2>Novo participante</h2>
            <p>Para o Cante Comigo, preencha a música e o autor: essas informações aparecerão para os jurados durante a avaliação.</p>
            <div className="form-grid">
              <label className="wide">Nome completo<input name="full_name" required /></label>
              <label>Idade<input name="age" inputMode="numeric" maxLength={24} placeholder="Ex.: 14" /></label>
              <label>Data de nascimento<input name="birth_date" type="date" /></label>
              <label>Sexo<select name="sex"><option value="">Não informado</option><option>Masculino</option><option>Feminino</option></select></label>
              <label>Telefone<input name="phone" inputMode="tel" /></label>
              <label>Responsável<input name="guardian" /></label>
              <label>Polo<input name="school" /></label>
              <label>Professor / mestre<input name="teacher" /></label>
              <label>Graduação<input name="graduation" /></label>
              <label>Evento<select value={eventId} onChange={(eventChange) => setEventId(eventChange.target.value)}>{initialEvents.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
              <label className="wide">Categoria<select name="category_id" required><option value="">Selecione...</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.competition} · {category.name}</option>)}</select></label>
              <label className="wide">Música que vai cantar<input name="song_title" maxLength={250} placeholder="Ex.: Angola" /></label>
              <label className="wide">Autor / intérprete da música<input name="song_author" maxLength={250} placeholder="Ex.: Mestre Pastinha" /></label>
              <label className="wide">Observações<input name="notes" /></label>
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions"><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancelar</button><button className="primary" disabled={loading}>{loading ? "Salvando..." : "Cadastrar e inscrever"}</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
