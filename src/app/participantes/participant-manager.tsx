"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRightLeft, Pencil, Plus, Search, Trash2, UserRound, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Category = { id: string; name: string };
type Competition = { id: string; name: string; categories: Category[] };
type EventItem = { id: string; name: string; competitions: Competition[] };

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

type RegistrationDetails = {
  registration: Registration;
  event?: EventItem;
  competition?: Competition;
  category?: Category;
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

function detailsFor(registration: Registration, events: EventItem[]): RegistrationDetails {
  const event = events.find((item) => item.id === registration.event_id);
  const competition = event?.competitions.find((item) => item.categories.some((category) => category.id === registration.category_id));
  return {
    registration,
    event,
    competition,
    category: competition?.categories.find((category) => category.id === registration.category_id),
  };
}

function registrationLabel(details: RegistrationDetails) {
  return [details.event?.name, details.competition?.name, details.category?.name]
    .filter(Boolean)
    .join(" · ") || "Inscrição sem categoria";
}

function categoriesLabel(participant: Participant, events: EventItem[]) {
  const labels = participant.registrations.map((registration) => {
    const details = detailsFor(registration, events);
    return details.category?.name || "Sem categoria";
  });
  return [...new Set(labels)].join(" · ") || "Sem inscrição";
}

function actionMessage(message: string) {
  if (/already started|received scores/i.test(message)) return "Esta apresentação já foi iniciada ou recebeu notas. Para proteger o resultado, ela não pode mais ser alterada.";
  if (/already has a result/i.test(message)) return "Este participante já possui resultado homologado e não pode ser alterado.";
  if (/match bracket/i.test(message)) return "Remova primeiro o participante da chave de confrontos para fazer essa alteração.";
  if (/already registered/i.test(message)) return "O participante já está inscrito nessa categoria.";
  if (/same competition/i.test(message)) return "A troca é permitida somente entre categorias da mesma competição.";
  if (/select at least one/i.test(message)) return "Selecione pelo menos um participante.";
  if (/selected registrations were not found/i.test(message)) return "Uma das inscrições selecionadas não foi encontrada. Atualize a página e tente novamente.";
  if (/must belong to one event/i.test(message)) return "Selecione participantes de um único evento por vez.";
  if (/could not find the function|schema cache/i.test(message)) return "A atualização de gerenciamento ainda não foi aplicada ao banco. Execute a atualização do Supabase e recarregue a página.";
  return message;
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
  const router = useRouter();
  const [participants, setParticipants] = useState(initialParticipants);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [eventId, setEventId] = useState(() => initialEvents.find((event) =>
    initialParticipants.some((participant) => participant.registrations.some((registration) => registration.event_id === event.id)),
  )?.id || initialEvents[0]?.id || "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<Set<string>>(() => new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState("");
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [managedParticipant, setManagedParticipant] = useState<Participant | null>(null);
  const [managedRegistrationId, setManagedRegistrationId] = useState("");
  const [targetCategoryId, setTargetCategoryId] = useState("");
  const [manageError, setManageError] = useState("");
  const [manageAction, setManageAction] = useState<"move" | "delete" | "">("");
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);

  const event = initialEvents.find((item) => item.id === eventId);
  const categories = event?.competitions.flatMap((competition) =>
    competition.categories.map((category) => ({ ...category, competition: competition.name })),
  ) || [];
  const eventParticipants = useMemo(() => participants
    .map((participant) => ({
      ...participant,
      registrations: participant.registrations.filter((registration) => registration.event_id === eventId),
    }))
    .filter((participant) => participant.registrations.length > 0), [participants, eventId]);
  const filtered = useMemo(
    () => eventParticipants.filter((item) => item.full_name.toLowerCase().includes(query.toLowerCase())),
    [eventParticipants, query],
  );
  const selectedParticipants = useMemo(
    () => eventParticipants.filter((participant) => selectedParticipantIds.has(participant.id)),
    [eventParticipants, selectedParticipantIds],
  );
  const selectedRegistrationIds = useMemo(
    () => selectedParticipants.flatMap((participant) => participant.registrations.map((registration) => registration.id)),
    [selectedParticipants],
  );
  const allFilteredSelected = filtered.length > 0 && filtered.every((participant) => selectedParticipantIds.has(participant.id));
  const managedRegistration = managedParticipant?.registrations.find((registration) => registration.id === managedRegistrationId);
  const managedDetails = managedRegistration ? detailsFor(managedRegistration, initialEvents) : undefined;
  const availableCategories = managedDetails?.competition?.categories.filter((category) => category.id !== managedRegistration?.category_id) || [];
  const managedRegistrationCount = participants.find((participant) => participant.id === managedParticipant?.id)?.registrations.length || 0;

  function closeManager() {
    setManagedParticipant(null);
    setManagedRegistrationId("");
    setTargetCategoryId("");
    setManageError("");
    setManageAction("");
    setDeleteConfirmation(false);
  }

  function openManager(participant: Participant) {
    setManagedParticipant(participant);
    setManagedRegistrationId(participant.registrations[0]?.id || "");
    setTargetCategoryId("");
    setManageError("");
    setManageAction("");
    setDeleteConfirmation(false);
  }

  function changeEvent(nextEventId: string) {
    setEventId(nextEventId);
    setSelectedParticipantIds(new Set());
    setBulkDeleteOpen(false);
    setBulkDeleteError("");
  }

  function toggleParticipantSelection(participantId: string) {
    setSelectedParticipantIds((current) => {
      const next = new Set(current);
      if (next.has(participantId)) next.delete(participantId);
      else next.add(participantId);
      return next;
    });
  }

  function toggleAllVisibleParticipants() {
    setSelectedParticipantIds((current) => {
      const next = new Set(current);
      if (allFilteredSelected) filtered.forEach((participant) => next.delete(participant.id));
      else filtered.forEach((participant) => next.add(participant.id));
      return next;
    });
  }

  async function submit(eventSubmit: FormEvent<HTMLFormElement>) {
    eventSubmit.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");

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
    setNotice("Participante cadastrado e inscrito com sucesso.");
    setOpen(false);
    setLoading(false);
    router.refresh();
  }

  async function moveRegistration() {
    if (!managedParticipant || !managedRegistration || !targetCategoryId) {
      setManageError("Selecione a nova categoria.");
      return;
    }

    setManageAction("move");
    setManageError("");
    const { error: moveError } = await createClient().rpc("reassign_registration_category", {
      target_registration: managedRegistration.id,
      target_category: targetCategoryId,
    });

    if (moveError) {
      setManageError(actionMessage(moveError.message));
      setManageAction("");
      return;
    }

    const targetCategory = availableCategories.find((category) => category.id === targetCategoryId);
    setParticipants((items) => items.map((participant) => participant.id === managedParticipant.id ? {
      ...participant,
      registrations: participant.registrations.map((registration) => registration.id === managedRegistration.id
        ? { ...registration, category_id: targetCategoryId }
        : registration),
    } : participant));
    setNotice(`${managedParticipant.full_name} foi movido${targetCategory ? ` para ${targetCategory.name}` : " para a nova categoria"}. A fila e os juízes serão atualizados automaticamente.`);
    closeManager();
    router.refresh();
  }

  async function deleteRegistration() {
    if (!managedParticipant || !managedRegistration) return;

    setManageAction("delete");
    setManageError("");
    const { data, error: deleteError } = await createClient().rpc("delete_event_registration", {
      target_registration: managedRegistration.id,
    });

    if (deleteError) {
      setManageError(actionMessage(deleteError.message));
      setManageAction("");
      return;
    }

    const participantDeleted = Boolean((data as { participant_deleted?: boolean } | null)?.participant_deleted);
    setParticipants((items) => items.flatMap((participant) => {
      if (participant.id !== managedParticipant.id) return [participant];
      const registrations = participant.registrations.filter((registration) => registration.id !== managedRegistration.id);
      return registrations.length ? [{ ...participant, registrations }] : [];
    }));
    setNotice(participantDeleted
      ? `${managedParticipant.full_name} e sua única inscrição foram excluídos.`
      : `A inscrição de ${managedParticipant.full_name} foi excluída. As demais inscrições foram preservadas.`);
    closeManager();
    router.refresh();
  }

  async function deleteSelectedParticipants() {
    if (!selectedRegistrationIds.length) return;

    setBulkDeleting(true);
    setBulkDeleteError("");
    const { data, error: deleteError } = await createClient().rpc("delete_event_registrations", {
      target_registrations: selectedRegistrationIds,
    });

    if (deleteError) {
      setBulkDeleteError(actionMessage(deleteError.message));
      setBulkDeleting(false);
      return;
    }

    const selectedIds = new Set(selectedParticipantIds);
    const selectedRegistrationIdSet = new Set(selectedRegistrationIds);
    const profileCount = Number((data as { participant_count?: number } | null)?.participant_count || 0);
    setParticipants((items) => items.flatMap((participant) => {
      if (!selectedIds.has(participant.id)) return [participant];
      const registrations = participant.registrations.filter((registration) => !selectedRegistrationIdSet.has(registration.id));
      return registrations.length ? [{ ...participant, registrations }] : [];
    }));
    setSelectedParticipantIds(new Set());
    setBulkDeleteOpen(false);
    setBulkDeleting(false);
    setNotice(`${selectedRegistrationIds.length} inscrição(ões) de ${selectedParticipants.length} participante(s) foram excluídas.${profileCount ? ` ${profileCount} cadastro(s) sem outras inscrições também foi(ram) removido(s).` : ""}`);
    router.refresh();
  }

  return (
    <section className="participant-workspace">
      <div className="participant-tools">
        <label className="participant-event-filter">
          Evento
          <select value={eventId} onChange={(eventChange) => changeEvent(eventChange.target.value)}>
            {initialEvents.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="participant-search">
          <Search />
          <input value={query} onChange={(eventChange) => setQuery(eventChange.target.value)} placeholder="Buscar participante" />
        </label>
        <button className="primary" type="button" disabled={!initialEvents.length} onClick={() => setOpen(true)}><Plus />Novo participante</button>
      </div>

      {notice && <div className="login-success participant-notice" role="status">{notice}</div>}

      {filtered.length > 0 && (
        <div className="participant-selection-tools">
          <button type="button" className="secondary" onClick={toggleAllVisibleParticipants}>
            {allFilteredSelected ? "Desmarcar todos" : `Selecionar todos os ${filtered.length} exibidos`}
          </button>
          <small>Você também pode marcar somente os participantes que deseja excluir.</small>
        </div>
      )}

      {selectedParticipants.length > 0 && (
        <div className="participant-bulkbar" role="status">
          <div>
            <strong>{selectedParticipants.length} participante(s) selecionado(s)</strong>
            <span>{selectedRegistrationIds.length} inscrição(ões) no evento {event?.name || "selecionado"}</span>
          </div>
          <div>
            <button type="button" className="text-button" onClick={() => setSelectedParticipantIds(new Set())}>Limpar seleção</button>
            <button type="button" className="danger-button" onClick={() => { setBulkDeleteError(""); setBulkDeleteOpen(true); }}><Trash2 />Excluir selecionados</button>
          </div>
        </div>
      )}

      {filtered.length ? (
        <div className="participant-table">
          <div className="table-head">
            <input
              className="participant-select"
              type="checkbox"
              checked={allFilteredSelected}
              aria-label={allFilteredSelected ? "Desmarcar todos os participantes exibidos" : "Selecionar todos os participantes exibidos"}
              onChange={toggleAllVisibleParticipants}
            />
            <span>Participante</span><span>Categoria</span><span>Idade</span><span>Inscrições</span><span>Status</span><span>Ações</span>
          </div>
          {filtered.map((participant) => {
            const age = registrationAge(participant);
            const category = categoriesLabel(participant, initialEvents);
            return (
              <article key={participant.id} className={selectedParticipantIds.has(participant.id) ? "participant-row-selected" : ""}>
                <input
                  className="participant-select"
                  type="checkbox"
                  checked={selectedParticipantIds.has(participant.id)}
                  aria-label={`Selecionar ${participant.full_name}`}
                  onChange={() => toggleParticipantSelection(participant.id)}
                />
                <div className="participant-person"><span className="person-dot"><UserRound /></span><strong>{participant.full_name}</strong></div>
                <span className="participant-category" title={category}>{category}</span>
                <span className="participant-age">{age ? ageLabel(age) : "—"}</span>
                <span className="participant-count">{participant.registrations.length}</span>
                <b className="participant-status">Pendente</b>
                <button className="participant-manage" type="button" onClick={() => openManager(participant)} disabled={!participant.registrations.length}><Pencil />Gerenciar</button>
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
              <label>Evento<select value={eventId} onChange={(eventChange) => changeEvent(eventChange.target.value)}>{initialEvents.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
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

      {managedParticipant && (
        <div className="modal-wrap">
          <button className="backdrop" onClick={closeManager} aria-label="Fechar" />
          <section className="modal category-modal participant-manager-modal" role="dialog" aria-modal="true" aria-labelledby="manage-participant-title">
            <button type="button" className="modal-x" onClick={closeManager}><X /></button>
            <span className="eyebrow">GESTÃO DE INSCRIÇÃO</span>
            <h2 id="manage-participant-title">{managedParticipant.full_name}</h2>
            <p>Altere a categoria antes do início da avaliação ou exclua a inscrição do evento com segurança.</p>

            <div className="participant-management-summary">
              <label>Inscrição do participante
                <select value={managedRegistrationId} onChange={(eventChange) => {
                  setManagedRegistrationId(eventChange.target.value);
                  setTargetCategoryId("");
                  setManageError("");
                  setDeleteConfirmation(false);
                }}>
                  {managedParticipant.registrations.map((registration) => <option value={registration.id} key={registration.id}>{registrationLabel(detailsFor(registration, initialEvents))}</option>)}
                </select>
              </label>
              {managedDetails && <p><b>Categoria atual:</b> {managedDetails.category?.name || "Não identificada"}</p>}
            </div>

            <section className="participant-action-card">
              <span className="eyebrow">REALOCAR</span>
              <h3>Mover para outra categoria</h3>
              <p>A ficha seguirá para a nova categoria e ficará disponível para os juízes designados a ela.</p>
              <label>Nova categoria
                <select value={targetCategoryId} onChange={(eventChange) => { setTargetCategoryId(eventChange.target.value); setManageError(""); }} disabled={!availableCategories.length || Boolean(manageAction)}>
                  <option value="">Selecione...</option>
                  {availableCategories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}
                </select>
              </label>
              {!availableCategories.length && <small>Não há outra categoria disponível nesta competição.</small>}
              <button className="primary" type="button" disabled={!targetCategoryId || Boolean(manageAction)} onClick={() => void moveRegistration()}><ArrowRightLeft />{manageAction === "move" ? "Movendo..." : "Mover participante"}</button>
            </section>

            <section className="participant-action-card participant-danger-card">
              <span className="eyebrow">EXCLUSÃO</span>
              <h3>Excluir inscrição</h3>
              <p>{managedRegistrationCount === 1 ? "Esta é a única inscrição do participante; o cadastro também será removido." : "As outras inscrições deste participante, inclusive em outros eventos, serão preservadas."}</p>
              {!deleteConfirmation ? (
                <button className="danger-button" type="button" disabled={Boolean(manageAction)} onClick={() => setDeleteConfirmation(true)}><Trash2 />Excluir esta inscrição</button>
              ) : (
                <div className="delete-confirmation">
                  <p><AlertTriangle />Confirme a exclusão. Essa ação não poderá ser desfeita.</p>
                  <div><button className="secondary" type="button" disabled={manageAction === "delete"} onClick={() => setDeleteConfirmation(false)}>Cancelar</button><button className="danger-button" type="button" disabled={Boolean(manageAction)} onClick={() => void deleteRegistration()}><Trash2 />{manageAction === "delete" ? "Excluindo..." : "Confirmar exclusão"}</button></div>
                </div>
              )}
            </section>

            {manageError && <div className="form-error">{manageError}</div>}
          </section>
        </div>
      )}

      {bulkDeleteOpen && (
        <div className="modal-wrap">
          <button className="backdrop" type="button" disabled={bulkDeleting} onClick={() => setBulkDeleteOpen(false)} aria-label="Fechar" />
          <section className="modal category-modal participant-manager-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title">
            <button type="button" className="modal-x" disabled={bulkDeleting} onClick={() => setBulkDeleteOpen(false)}><X /></button>
            <span className="eyebrow participant-danger-eyebrow">EXCLUSÃO EM LOTE</span>
            <h2 id="bulk-delete-title">Excluir participantes selecionados</h2>
            <p>Serão removidas {selectedRegistrationIds.length} inscrição(ões) de {selectedParticipants.length} participante(s), somente do evento <b>{event?.name}</b>.</p>
            <div className="bulk-delete-summary">
              <strong>Participantes selecionados</strong>
              <ul>
                {selectedParticipants.slice(0, 8).map((participant) => <li key={participant.id}>{participant.full_name} <span>· {categoriesLabel(participant, initialEvents)}</span></li>)}
              </ul>
              {selectedParticipants.length > 8 && <small>e mais {selectedParticipants.length - 8} participante(s).</small>}
            </div>
            <div className="delete-confirmation">
              <p><AlertTriangle />A operação inteira será cancelada se alguma inscrição já tiver nota, resultado ou confronto iniciado.</p>
            </div>
            {bulkDeleteError && <div className="form-error" role="alert">{bulkDeleteError}</div>}
            <div className="modal-actions">
              <button type="button" className="secondary" disabled={bulkDeleting} onClick={() => setBulkDeleteOpen(false)}>Cancelar</button>
              <button type="button" className="danger-button" disabled={bulkDeleting || !selectedRegistrationIds.length} onClick={() => void deleteSelectedParticipants()}><Trash2 />{bulkDeleting ? "Excluindo..." : "Confirmar exclusão"}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
