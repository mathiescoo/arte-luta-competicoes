"use client";

import { useMemo, useState } from "react";
import { Check, Clock3, MapPinned, ShieldX, Trash2, UserRound, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Application = {
  id: string;
  full_name: string;
  email: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  user_id: string;
};

export type JudgeEventOption = {
  id: string;
  name: string;
  status: string;
  competitions: Array<{
    id: string;
    name: string;
    model: "sum_score" | "digital_flags";
    categories: Array<{ id: string; name: string }>;
  }>;
  rings: Array<{ id: string; name: string }>;
};

export default function JudgeApplications({
  organizationId,
  initialApplications,
  events,
}: {
  organizationId: string;
  initialApplications: Application[];
  events: JudgeEventOption[];
}) {
  const [applications, setApplications] = useState(initialApplications);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState("");
  const [designationTarget, setDesignationTarget] = useState<Application | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Application | null>(null);
  const [eventId, setEventId] = useState(events[0]?.id || "");
  const [competitionId, setCompetitionId] = useState(events[0]?.competitions[0]?.id || "");
  const [categoryId, setCategoryId] = useState(events[0]?.competitions[0]?.categories[0]?.id || "");
  const [ringId, setRingId] = useState("");

  const selectedEvent = useMemo(() => events.find((item) => item.id === eventId), [events, eventId]);
  const competitions = selectedEvent?.competitions || [];
  const selectedCompetition = competitions.find((item) => item.id === competitionId);
  const categories = selectedCompetition?.categories || [];
  const needsRing = selectedCompetition?.model === "digital_flags";
  const pendingCount = applications.filter((item) => item.status === "pending").length;

  function startDesignation(application: Application) {
    setError("");
    setNotice("");
    setDesignationTarget(application);
    const firstEvent = events[0];
    const firstCompetition = firstEvent?.competitions[0];
    setEventId(firstEvent?.id || "");
    setCompetitionId(firstCompetition?.id || "");
    setCategoryId(firstCompetition?.categories[0]?.id || "");
    setRingId("");
  }

  async function designate() {
    if (!designationTarget || !selectedEvent || !selectedCompetition || !categoryId || (needsRing && !ringId)) {
      setError(needsRing
        ? "Escolha o evento, a competição, a categoria e a roda para esta designação."
        : "Escolha o evento, a competição e a categoria para esta designação.");
      return;
    }

    setError("");
    setWorking(designationTarget.id);
    const { error: assignError } = await createClient().rpc("admin_assign_judge_to_event", {
      target_application: designationTarget.id,
      target_event: selectedEvent.id,
      target_competition: selectedCompetition.id,
      target_category: categoryId,
      target_ring: needsRing ? ringId : null,
    });
    if (assignError) {
      setError(assignError.message.includes("PGRST202")
        ? "A atualização de banco para direcionar juízes ainda não foi aplicada no Supabase."
        : "Não foi possível direcionar o juiz. Confirme que o evento está aberto e que a designação ainda não foi iniciada.");
      setWorking("");
      return;
    }

    setApplications((items) => items.map((item) => item.id === designationTarget.id
      ? { ...item, status: "approved" }
      : item));
    setNotice(`${designationTarget.full_name} autorizado(a) e direcionado(a) para ${selectedEvent.name} · ${selectedCompetition.name} · ${categories.find((item) => item.id === categoryId)?.name}.`);
    setDesignationTarget(null);
    setRingId("");
    setWorking("");
  }

  async function reject(application: Application) {
    setError("");
    setNotice("");
    setWorking(application.id);
    const { error: rejectError } = await createClient().rpc("review_judge_application", {
      target_application: application.id,
      approved: false,
    });
    if (rejectError) {
      setError("Não foi possível recusar esta solicitação. Verifique a conexão e atualize a página.");
      setWorking("");
      return;
    }
    setApplications((items) => items.map((item) => item.id === application.id ? { ...item, status: "rejected" } : item));
    setWorking("");
  }

  async function remove(application: Application) {
    setError("");
    setNotice("");
    setWorking(application.id);
    const { error: removeError } = await createClient().rpc("remove_judge_from_organization", {
      target_user: application.user_id,
      target_organization: organizationId,
    });
    if (removeError) {
      setError(removeError.message.includes("PGRST202")
        ? "A atualização de banco para excluir juízes ainda não foi aplicada no Supabase."
        : "Não foi possível excluir o acesso. Se uma avaliação estiver em andamento, finalize ou reinicie essa avaliação primeiro.");
      setWorking("");
      return;
    }
    setApplications((items) => items.filter((item) => item.id !== application.id));
    setRemoveTarget(null);
    setNotice(`${application.full_name} removido(a) dos acessos de juiz. O histórico de avaliações foi preservado.`);
    setWorking("");
  }

  const statusLabel = (status: Application["status"]) => ({
    pending: "Aguardando análise",
    approved: "Acesso ativo",
    rejected: "Recusado",
  })[status];

  return (
    <section className="applications-workspace">
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="form-success" role="status">{notice}</div>}
      <div className="applications-summary">
        <Clock3 /><span>{pendingCount} solicitação(ões) aguardando análise</span>
      </div>
      <div className="applications-guidance">
        O juiz só recebe acesso depois que você o direcionar a um evento, competição e categoria. Ao remover o acesso, notas e votos anteriores ficam preservados no histórico.
      </div>
      <div className="judge-list applications-list">
        {applications.length ? applications.map((application) => (
          <article key={application.id}>
            <span className="person-dot"><UserRound /></span>
            <div className="application-identity">
              <strong>{application.full_name}</strong>
              <span>{application.email} · solicitado em {new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(application.created_at))}</span>
            </div>
            <b className={`application-status ${application.status}`}>{statusLabel(application.status)}</b>
            <div className="application-actions">
              <button className="approve" disabled={!!working || !events.length} onClick={() => startDesignation(application)}>
                <MapPinned />{application.status === "pending" ? "Permitir e direcionar" : application.status === "rejected" ? "Permitir para um evento" : "Direcionar para evento"}
              </button>
              {application.status === "pending" && <button disabled={!!working} onClick={() => void reject(application)}><ShieldX />Recusar</button>}
              <button className="danger" disabled={!!working} onClick={() => { setError(""); setRemoveTarget(application); }}>
                <Trash2 />{application.status === "approved" ? "Excluir juiz do app" : "Excluir solicitação"}
              </button>
            </div>
          </article>
        )) : <div className="empty-state compact"><UserRound /><h2>Nenhum acesso ou solicitação</h2><p>Quando alguém solicitar acesso, você poderá autorizar e direcionar essa pessoa para um evento específico.</p></div>}
      </div>

      {designationTarget && <div className="modal-wrap">
        <button className="backdrop" aria-label="Fechar" disabled={!!working} onClick={() => setDesignationTarget(null)} />
        <section className="modal judge-assignment-modal" role="dialog" aria-modal="true" aria-labelledby="judge-assignment-title">
          <button className="modal-x" aria-label="Fechar" disabled={!!working} onClick={() => setDesignationTarget(null)}><X /></button>
          <span className="eyebrow">ACESSO POR EVENTO</span>
          <h2 id="judge-assignment-title">Direcionar {designationTarget.full_name}</h2>
          <p>Ao confirmar, o juiz será liberado somente para atuar na designação escolhida. O acesso poderá ser removido a qualquer momento pela administração.</p>
          {!events.length ? <div className="form-error">Crie um evento antes de liberar um juiz.</div> : <div className="judge-assignment-fields">
            <label>Evento<select value={eventId} onChange={(change) => {
              const nextEvent = events.find((item) => item.id === change.target.value);
              const nextCompetition = nextEvent?.competitions[0];
              setEventId(change.target.value);
              setCompetitionId(nextCompetition?.id || "");
              setCategoryId(nextCompetition?.categories[0]?.id || "");
              setRingId("");
            }}><option value="">Selecione o evento</option>{events.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Competição<select value={competitionId} onChange={(change) => {
              const nextCompetition = competitions.find((item) => item.id === change.target.value);
              setCompetitionId(change.target.value);
              setCategoryId(nextCompetition?.categories[0]?.id || "");
              setRingId("");
            }} disabled={!competitions.length}><option value="">Selecione a competição</option>{competitions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Categoria<select value={categoryId} onChange={(change) => setCategoryId(change.target.value)} disabled={!categories.length}><option value="">Selecione a categoria</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            {needsRing && <label>Roda<select value={ringId} onChange={(change) => setRingId(change.target.value)}><option value="">Selecione a roda</option>{(selectedEvent?.rings || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            {!categories.length && selectedCompetition && <div className="form-error">Esta competição ainda não possui categorias para designar o juiz.</div>}
          </div>}
          <div className="modal-actions">
            <button className="secondary" disabled={!!working} onClick={() => setDesignationTarget(null)}>Cancelar</button>
            <button className="primary" disabled={!!working || !selectedEvent || !selectedCompetition || !categoryId || (needsRing && !ringId)} onClick={() => void designate()}>
              <Check />{working === designationTarget.id ? "Salvando..." : "Autorizar e direcionar"}
            </button>
          </div>
        </section>
      </div>}

      {removeTarget && <div className="modal-wrap">
        <button className="backdrop" aria-label="Fechar" disabled={!!working} onClick={() => setRemoveTarget(null)} />
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="remove-judge-title">
          <h2 id="remove-judge-title">{removeTarget.status === "approved" ? "Excluir juiz do app?" : "Excluir solicitação?"}</h2>
          <p>{removeTarget.status === "approved"
            ? `O acesso de ${removeTarget.full_name} e suas designações abertas serão removidos. A conta de autenticação e os registros de notas/votos permanecerão para manter o histórico; para voltar, será necessária nova autorização e designação do administrador.`
            : `A solicitação de ${removeTarget.full_name} será apagada. Se essa pessoa solicitar acesso novamente, o administrador precisará direcioná-la a um evento.`}</p>
          <div className="modal-actions">
            <button className="secondary" disabled={!!working} onClick={() => setRemoveTarget(null)}>Cancelar</button>
            <button className="primary danger-button" disabled={!!working} onClick={() => void remove(removeTarget)}>
              <Trash2 />{working === removeTarget.id ? "Removendo..." : "Confirmar exclusão"}
            </button>
          </div>
        </section>
      </div>}
    </section>
  );
}
