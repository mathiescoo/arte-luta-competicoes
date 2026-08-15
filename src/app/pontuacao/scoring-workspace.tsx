"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Award,
  Check,
  ChevronDown,
  ClipboardList,
  LoaderCircle,
  Music2,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Send,
  Trophy,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import styles from "./scoring.module.css";
import responsiveStyles from "./scoring-responsive.module.css";

type ManageableEvent = {
  id: string;
  name: string;
  starts_at: string | null;
  status: string;
};

type Criterion = {
  id: string;
  name: string;
  description: string | null;
  min_score: number;
  max_score: number;
  sort_order: number;
};

type Presentation = {
  id: string;
  registration_id: string;
  participant_name: string;
  sort_order: number;
  status: "waiting" | "live" | "finished";
  submitted_scorecards: number;
  total_score: number | null;
};

type ScoringCategory = {
  id: string;
  name: string;
  registration_count: number;
  active_judges: number;
  presentations: Presentation[];
};

type ScoringCompetition = {
  id: string;
  name: string;
  criteria: Criterion[];
  categories: ScoringCategory[];
};

type AdminWorkspace = {
  event: { id: string; name: string; starts_at: string | null; status: string };
  competitions: ScoringCompetition[];
};

type JudgeQueueItem = {
  event_id: string;
  event_name: string;
  competition_name: string;
  category_name: string;
  presentation_id: string;
  assignment_id: string;
  participant_name: string;
  participant_age: string | null;
  song_title: string | null;
  song_author: string | null;
  sort_order: number;
  status: "live";
  submitted: boolean;
  submitted_at: string | null;
  note: string | null;
  scores: Record<string, number | string>;
  criteria: Criterion[];
};

type CriterionDraft = {
  name: string;
  description: string;
  min_score: string;
  max_score: string;
};

const defaultCriteria: CriterionDraft[] = [
  { name: "Ritmo e musicalidade", description: "Tempo, afinação e domínio da música.", min_score: "0", max_score: "10" },
  { name: "Expressão e presença", description: "Segurança, interpretação e presença no palco.", min_score: "0", max_score: "10" },
  { name: "Conhecimento da capoeira", description: "Coerência com a tradição e repertório apresentado.", min_score: "0", max_score: "10" },
];

const presentationStatus: Record<Presentation["status"], string> = {
  waiting: "Na fila",
  live: "Em avaliação",
  finished: "Concluída",
};

function messageFrom(error: { message?: string } | null, fallback: string) {
  return error?.message || fallback;
}

function totalLabel(total: number | null) {
  if (total === null || Number.isNaN(Number(total))) return "Aguardando notas";
  return `${Number(total).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pontos`;
}

function dateLabel(value: string | null) {
  if (!value) return "Data a definir";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

function timeLabel(value: string | null) {
  if (!value) return "agora";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function ageLabel(value: string | null) {
  if (!value) return "Não informada";
  return /\bano(?:s)?\b/i.test(value) ? value : `${value} anos`;
}

export default function ScoringWorkspace({ canManage, canJudge }: { canManage: boolean; canJudge: boolean }) {
  const [events, setEvents] = useState<ManageableEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [workspace, setWorkspace] = useState<AdminWorkspace | null>(null);
  const [judgeQueue, setJudgeQueue] = useState<JudgeQueueItem[]>([]);
  const [managerLoading, setManagerLoading] = useState(canManage);
  const [judgeLoading, setJudgeLoading] = useState(canJudge);
  const [judgeQueueUpdatedAt, setJudgeQueueUpdatedAt] = useState<Date | null>(null);
  const [scoreErrors, setScoreErrors] = useState<Record<string, string>>({});
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [criteriaCompetition, setCriteriaCompetition] = useState<ScoringCompetition | null>(null);
  const [criteriaDraft, setCriteriaDraft] = useState<CriterionDraft[]>(defaultCriteria);

  const loadWorkspace = useCallback(async (eventId: string) => {
    if (!eventId) {
      setWorkspace(null);
      return;
    }
    setManagerLoading(true);
    const { data, error: loadError } = await createClient().rpc("scoring_admin_workspace", { target_event: eventId });
    if (loadError || !data) {
      setError(messageFrom(loadError, "Não foi possível carregar a configuração de pontuação."));
      setWorkspace(null);
    } else {
      setWorkspace(data as unknown as AdminWorkspace);
    }
    setManagerLoading(false);
  }, []);

  const loadManageableEvents = useCallback(async () => {
    if (!canManage) return;
    setManagerLoading(true);
    const { data, error: loadError } = await createClient().rpc("scoring_manageable_events");
    if (loadError) {
      setError(messageFrom(loadError, "Não foi possível carregar os eventos com notas."));
      setManagerLoading(false);
      return;
    }
    const nextEvents = (data || []) as ManageableEvent[];
    setEvents(nextEvents);
    const nextEventId = nextEvents.some((event) => event.id === selectedEventId)
      ? selectedEventId
      : nextEvents[0]?.id || "";
    setSelectedEventId(nextEventId);
    await loadWorkspace(nextEventId);
  }, [canManage, loadWorkspace, selectedEventId]);

  const loadJudgeQueue = useCallback(async (silent = false) => {
    if (!canJudge) return;
    if (!silent) setJudgeLoading(true);
    const { data, error: loadError } = await createClient().rpc("scoring_judge_queue");
    if (loadError) {
      if (!silent) {
        setError(messageFrom(loadError, "Não foi possível carregar sua fila de avaliações."));
        setJudgeQueue([]);
      }
    } else {
      setJudgeQueue((data || []) as unknown as JudgeQueueItem[]);
      setJudgeQueueUpdatedAt(new Date());
    }
    if (!silent) setJudgeLoading(false);
  }, [canJudge]);

  useEffect(() => {
    if (!canManage) return;
    const timer = window.setTimeout(() => void loadManageableEvents(), 0);
    return () => window.clearTimeout(timer);
  }, [canManage, loadManageableEvents]);

  useEffect(() => {
    if (!canJudge) return;
    const timer = window.setTimeout(() => void loadJudgeQueue(), 0);
    return () => window.clearTimeout(timer);
  }, [canJudge, loadJudgeQueue]);

  useEffect(() => {
    if (!canJudge) return;
    const refreshWhenVisible = () => {
      if (!document.hidden) void loadJudgeQueue(true);
    };
    const interval = window.setInterval(refreshWhenVisible, 15000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [canJudge, loadJudgeQueue]);

  async function refreshAll() {
    setError("");
    await Promise.all([
      canManage ? loadManageableEvents() : Promise.resolve(),
      canJudge ? loadJudgeQueue() : Promise.resolve(),
    ]);
  }

  function openCriteriaEditor(competition: ScoringCompetition) {
    setError("");
    setNotice("");
    setCriteriaCompetition(competition);
    setCriteriaDraft(
      competition.criteria.length
        ? competition.criteria.map((criterion) => ({
            name: criterion.name,
            description: criterion.description || "",
            min_score: String(criterion.min_score),
            max_score: String(criterion.max_score),
          }))
        : defaultCriteria.map((criterion) => ({ ...criterion })),
    );
  }

  function updateDraft(index: number, field: keyof CriterionDraft, value: string) {
    setCriteriaDraft((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
  }

  async function saveCriteria(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!criteriaCompetition) return;
    const invalid = criteriaDraft.some((criterion) => {
      const minimum = Number(criterion.min_score);
      const maximum = Number(criterion.max_score);
      return !criterion.name.trim() || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum > 10 || minimum >= maximum;
    });
    if (invalid) {
      setError("Informe o nome e uma faixa válida entre 0 e 10 para cada critério.");
      return;
    }
    setWorking("criteria");
    setError("");
    const { error: saveError } = await createClient().rpc("replace_scoring_criteria", {
      target_competition: criteriaCompetition.id,
      criteria: criteriaDraft.map((criterion) => ({
        name: criterion.name.trim(),
        description: criterion.description.trim(),
        min_score: Number(criterion.min_score),
        max_score: Number(criterion.max_score),
      })),
    });
    if (saveError) {
      setError(messageFrom(saveError, "Não foi possível salvar os critérios."));
    } else {
      setCriteriaCompetition(null);
      setNotice("Critérios salvos. Agora gere a ordem das apresentações por categoria.");
      await loadWorkspace(selectedEventId);
    }
    setWorking("");
  }

  async function generatePresentations(category: ScoringCategory) {
    setWorking(`presentations-${category.id}`);
    setError("");
    const { data, error: generateError } = await createClient().rpc("generate_scoring_presentations", { target_category: category.id });
    if (generateError) {
      setError(messageFrom(generateError, "Não foi possível gerar a fila de apresentações."));
    } else {
      setNotice(`${Number(data || 0)} apresentação(ões) adicionada(s) à fila.`);
      await loadWorkspace(selectedEventId);
    }
    setWorking("");
  }

  async function changePresentationStatus(presentation: Presentation, status: Presentation["status"]) {
    setWorking(`status-${presentation.id}`);
    setError("");
    const { error: statusError } = await createClient().rpc("set_scoring_presentation_status", {
      target_presentation: presentation.id,
      next_status: status,
    });
    if (statusError) {
      setError(messageFrom(statusError, "Não foi possível atualizar a apresentação."));
    } else {
      setNotice(status === "live" ? "Apresentação aberta para os juízes." : status === "finished" ? "Apresentação concluída." : "Apresentação devolvida para a fila.");
      await Promise.all([loadWorkspace(selectedEventId), canJudge ? loadJudgeQueue() : Promise.resolve()]);
    }
    setWorking("");
  }

  async function generateResults(category: ScoringCategory) {
    setWorking(`results-${category.id}`);
    setError("");
    const { data, error: resultsError } = await createClient().rpc("homologate_scoring_results", { target_category: category.id });
    if (resultsError) {
      setError(messageFrom(resultsError, "Não foi possível gerar a classificação."));
    } else {
      setNotice(`Classificação calculada para ${Number(data || 0)} participante(s). Confira em Resultados antes de publicar.`);
      await loadWorkspace(selectedEventId);
    }
    setWorking("");
  }

  async function submitScore(event: FormEvent<HTMLFormElement>, item: JudgeQueueItem) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const submittedScores = item.criteria.map((criterion) => ({
      criterion_id: criterion.id,
      score: String(form.get(`criterion-${criterion.id}`) || "").trim().replace(",", "."),
    }));
    const invalidIndex = submittedScores.findIndex((score, index) => {
      const value = Number(score.score);
      const criterion = item.criteria[index];
      return !score.score || !Number.isFinite(value) || value < criterion.min_score || value > criterion.max_score;
    });
    if (invalidIndex !== -1) {
      const criterion = item.criteria[invalidIndex];
      const message = `Informe uma nota entre ${criterion.min_score} e ${criterion.max_score} para “${criterion.name}”.`;
      setScoreErrors((current) => ({ ...current, [item.presentation_id]: message }));
      setError("");
      const control = formElement.elements.namedItem(`criterion-${criterion.id}`);
      if (control instanceof HTMLInputElement) control.focus();
      return;
    }
    setWorking(`score-${item.presentation_id}`);
    setError("");
    setScoreErrors((current) => {
      const next = { ...current };
      delete next[item.presentation_id];
      return next;
    });
    const { error: scoreError } = await createClient().rpc("submit_scoring_scorecard", {
      target_presentation: item.presentation_id,
      target_assignment: item.assignment_id,
      submitted_scores: submittedScores,
      submitted_note: String(form.get("note") || ""),
    });
    if (scoreError) {
      setScoreErrors((current) => ({ ...current, [item.presentation_id]: messageFrom(scoreError, "Não foi possível registrar suas notas.") }));
    } else {
      setNotice("Notas registradas com sucesso. Você pode corrigi-las enquanto a apresentação estiver aberta.");
      await Promise.all([loadJudgeQueue(), canManage ? loadWorkspace(selectedEventId) : Promise.resolve()]);
    }
    setWorking("");
  }

  return (
    <section className={`${styles.workspace} ${responsiveStyles.workspace}`}>
      <div className={`${styles.refreshRow} ${responsiveStyles.refreshRow}`}>
        <span>{canManage && canJudge ? "Gestão e avaliação" : canManage ? "Gestão da avaliação" : "Painel individual do juiz"}</span>
        <button className={`${styles.refreshButton} ${responsiveStyles.refreshButton}`} onClick={() => void refreshAll()} disabled={managerLoading || judgeLoading || Boolean(working)}>
          <RefreshCw /> Atualizar
        </button>
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className={styles.notice} role="status"><Check />{notice}</div>}

      {canManage && (
        <section className={`${styles.managerSection} ${responsiveStyles.managerSection}`} aria-labelledby="scoring-management-title">
          <div className={`${styles.sectionHeading} ${responsiveStyles.sectionHeading}`}>
            <div>
              <span className="eyebrow">ORGANIZAÇÃO</span>
              <h2 id="scoring-management-title">Preparar avaliações</h2>
              <p>Uma apresentação por vez fica aberta aos juízes da categoria.</p>
            </div>
            <label className={`${styles.eventSelect} ${responsiveStyles.eventSelect}`}>
              Evento
              <select
                value={selectedEventId}
                onChange={(event) => {
                  const eventId = event.target.value;
                  setSelectedEventId(eventId);
                  setError("");
                  void loadWorkspace(eventId);
                }}
                disabled={managerLoading || !events.length}
              >
                {events.map((event) => <option key={event.id} value={event.id}>{event.name} · {dateLabel(event.starts_at)}</option>)}
              </select>
            </label>
          </div>

          {managerLoading ? (
            <div className={styles.loading}><LoaderCircle /> Carregando configuração de notas…</div>
          ) : !events.length ? (
            <div className={styles.empty}><Music2 /><h3>Nenhum Cante Comigo disponível</h3><p>Crie um evento e selecione a competição Cante Comigo Capoeira Intérpretes.</p></div>
          ) : !workspace?.competitions.length ? (
            <div className={styles.empty}><Music2 /><h3>Nenhuma competição por notas</h3><p>Este evento não possui uma competição configurada com somatório de notas.</p></div>
          ) : (
            <div className={styles.competitionList}>
              {workspace.competitions.map((competition) => (
                <article className={styles.competitionCard} key={competition.id}>
                  <div className={`${styles.competitionHead} ${responsiveStyles.competitionHead}`}>
                    <div>
                      <span className="eyebrow">SOMATÓRIO DE NOTAS</span>
                      <h3>{competition.name}</h3>
                      <p>{competition.criteria.length ? `${competition.criteria.length} critério(s) configurado(s).` : "Defina os critérios antes de gerar a fila."}</p>
                    </div>
                    <button className={`${styles.outlineButton} ${responsiveStyles.outlineButton}`} onClick={() => openCriteriaEditor(competition)}><PencilLine />{competition.criteria.length ? "Editar critérios" : "Configurar critérios"}</button>
                  </div>

                  {competition.criteria.length > 0 && (
                    <div className={styles.criteriaSummary}>
                      {competition.criteria.map((criterion) => <span key={criterion.id}>{criterion.name} <b>{criterion.min_score}–{criterion.max_score}</b></span>)}
                    </div>
                  )}

                  <div className={styles.categoryList}>
                    {competition.categories.length ? competition.categories.map((category) => (
                      <section className={styles.categoryCard} key={category.id}>
                        <div className={`${styles.categoryHead} ${responsiveStyles.categoryHead}`}>
                          <div>
                            <h4>{category.name}</h4>
                            <p>{category.registration_count} inscrito(s) · {category.active_judges} juiz(es) ativo(s) · {category.presentations.length} apresentação(ões) na fila</p>
                          </div>
                          <div className={`${styles.categoryActions} ${responsiveStyles.categoryActions}`}>
                            <button
                              className={`${styles.outlineButton} ${responsiveStyles.outlineButton}`}
                              disabled={!competition.criteria.length || !category.registration_count || working === `presentations-${category.id}`}
                              onClick={() => void generatePresentations(category)}
                            >
                              {working === `presentations-${category.id}` ? <LoaderCircle /> : <ClipboardList />} Gerar fila
                            </button>
                            <button
                              className={`${styles.primaryButton} ${responsiveStyles.primaryButton}`}
                              disabled={!category.presentations.length || working === `results-${category.id}`}
                              onClick={() => void generateResults(category)}
                            >
                              {working === `results-${category.id}` ? <LoaderCircle /> : <Trophy />} Gerar classificação
                            </button>
                          </div>
                        </div>

                        {category.presentations.length ? (
                          <ol className={`${styles.presentationList} ${responsiveStyles.presentationList}`}>
                            {category.presentations.map((presentation) => (
                              <li key={presentation.id}>
                                <div className={styles.queueNumber}>{presentation.sort_order}</div>
                                <div className={`${styles.presentationName} ${responsiveStyles.presentationName}`}>
                                  <strong>{presentation.participant_name}</strong>
                                  <span>{presentation.submitted_scorecards}/{category.active_judges} ficha(s) enviada(s) · {totalLabel(presentation.total_score)}</span>
                                </div>
                                <span className={`${styles.status} ${styles[presentation.status]}`}>{presentationStatus[presentation.status]}</span>
                                <div className={`${styles.presentationActions} ${responsiveStyles.presentationActions}`}>
                                  {presentation.status !== "live" && <button disabled={Boolean(working)} onClick={() => void changePresentationStatus(presentation, "live")}><Play /> Abrir</button>}
                                  {presentation.status === "live" && <button disabled={Boolean(working)} onClick={() => void changePresentationStatus(presentation, "finished")}><Check /> Concluir</button>}
                                  {presentation.status === "finished" && <button disabled={Boolean(working)} onClick={() => void changePresentationStatus(presentation, "waiting")}><ChevronDown /> Reabrir fila</button>}
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className={styles.emptyCategory}>As inscrições desta categoria aparecerão aqui após gerar a fila.</p>
                        )}
                      </section>
                    )) : <p className={styles.emptyCategory}>Cadastre uma categoria no evento para organizar as apresentações.</p>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {canJudge && (
        <section className={`${styles.judgeSection} ${responsiveStyles.judgeSection}`} aria-labelledby="judge-scoring-title">
          <div className={`${styles.sectionHeading} ${responsiveStyles.sectionHeading}`}>
            <div>
              <span className="eyebrow">PAINEL DO JUIZ</span>
              <h2 id="judge-scoring-title">Avaliações abertas</h2>
              <p>As notas ficam visíveis apenas para você até a organização concluir a apresentação.</p>
            </div>
          </div>
          <div className={responsiveStyles.judgeGuide}>
            <Check aria-hidden="true" />
            <div>
              <strong>Como avaliar</strong>
              <span>Preencha todos os critérios, confira as notas e toque em “Registrar notas”. Enquanto a apresentação estiver aberta, você pode corrigir sua ficha.</span>
            </div>
          </div>
          <div className={responsiveStyles.judgeSync} role="status">
            Atualização automática ativa{judgeQueueUpdatedAt ? ` · atualizado às ${timeLabel(judgeQueueUpdatedAt.toISOString())}` : ""}
          </div>
          {judgeLoading ? (
            <div className={styles.loading}><LoaderCircle /> Carregando suas avaliações…</div>
          ) : judgeQueue.length ? (
            <div className={`${styles.judgeGrid} ${responsiveStyles.judgeGrid}`}>
              {judgeQueue.map((item) => (
                <form className={`${styles.scorecard} ${responsiveStyles.scorecard}`} key={`${item.presentation_id}-${item.assignment_id}`} onSubmit={(event) => void submitScore(event, item)} aria-label={`Ficha de avaliação de ${item.participant_name}`} aria-busy={working === `score-${item.presentation_id}`}>
                  <div className={`${styles.scorecardHead} ${responsiveStyles.scorecardHead}`}>
                    <div>
                      <span>{item.event_name}</span>
                      <h3>{item.participant_name}</h3>
                      <p>{item.competition_name} · {item.category_name} · Ordem {item.sort_order}</p>
                    </div>
                    {item.submitted && <b><Check /> Salvo às {timeLabel(item.submitted_at)}</b>}
                  </div>
                  <dl className={responsiveStyles.participantBrief} aria-label={`Dados de ${item.participant_name}`}>
                    <div><dt>Categoria</dt><dd>{item.category_name}</dd></div>
                    <div><dt>Idade</dt><dd>{ageLabel(item.participant_age)}</dd></div>
                    <div><dt>Música</dt><dd>{item.song_title || "Não informada"}</dd></div>
                    <div><dt>Autor da música</dt><dd>{item.song_author || "Não informado"}</dd></div>
                  </dl>
                  <div className={`${styles.scoreInputs} ${responsiveStyles.scoreInputs}`}>
                    {item.criteria.map((criterion) => {
                      const savedValue = item.scores?.[criterion.id];
                      const inputId = `score-${item.presentation_id}-${criterion.id}`;
                      const rangeId = `${inputId}-range`;
                      return (
                        <label key={criterion.id}>
                          <span><strong>{criterion.name}</strong>{criterion.description && <small>{criterion.description}</small>}</span>
                          <input
                            id={inputId}
                            name={`criterion-${criterion.id}`}
                            type="text"
                            inputMode="decimal"
                            pattern="[0-9]+([,.][0-9]+)?"
                            placeholder="0,00"
                            required
                            autoComplete="off"
                            defaultValue={savedValue === undefined ? "" : String(savedValue)}
                            aria-describedby={rangeId}
                            aria-invalid={Boolean(scoreErrors[item.presentation_id])}
                            onChange={() => setScoreErrors((current) => {
                              if (!current[item.presentation_id]) return current;
                              const next = { ...current };
                              delete next[item.presentation_id];
                              return next;
                            })}
                          />
                          <em id={rangeId}>{criterion.min_score}–{criterion.max_score}</em>
                        </label>
                      );
                    })}
                  </div>
                  {scoreErrors[item.presentation_id] && <div className={responsiveStyles.scoreError} role="alert">{scoreErrors[item.presentation_id]}</div>}
                  <label className={styles.noteField}>Observação opcional<textarea name="note" maxLength={1000} defaultValue={item.note || ""} placeholder="Use apenas para observações da comissão." autoComplete="off" /></label>
                  <button className={`${styles.submitButton} ${responsiveStyles.submitButton}`} disabled={working === `score-${item.presentation_id}`}>
                    {working === `score-${item.presentation_id}` ? <LoaderCircle /> : <Send />}
                    {item.submitted ? "Atualizar notas" : "Registrar notas"}
                  </button>
                </form>
              ))}
            </div>
          ) : (
            <div className={styles.empty}><Award /><h3>Nenhuma apresentação aberta</h3><p>Quando a organização abrir sua categoria, a ficha de avaliação aparecerá aqui.</p></div>
          )}
        </section>
      )}

      {criteriaCompetition && (
        <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-labelledby="criteria-modal-title">
          <button className={styles.modalBackdrop} onClick={() => setCriteriaCompetition(null)} aria-label="Fechar configuração" />
          <form className={`${styles.criteriaModal} ${responsiveStyles.criteriaModal}`} onSubmit={(event) => void saveCriteria(event)}>
            <div className={styles.modalHeading}>
              <div><span className="eyebrow">{criteriaCompetition.name}</span><h2 id="criteria-modal-title">Critérios de avaliação</h2><p>Defina de 1 a 12 critérios. Depois da primeira ficha enviada, a edição fica bloqueada para preservar o resultado.</p></div>
              <button type="button" className={styles.iconButton} onClick={() => setCriteriaCompetition(null)} aria-label="Fechar"><X /></button>
            </div>
            <div className={`${styles.criteriaDrafts} ${responsiveStyles.criteriaDrafts}`}>
              {criteriaDraft.map((criterion, index) => (
                <fieldset key={`${index}-${criterion.name}`}>
                  <legend>Critério {index + 1}</legend>
                  <label>Nome<input value={criterion.name} maxLength={80} onChange={(event) => updateDraft(index, "name", event.target.value)} required /></label>
                  <label>Descrição opcional<input value={criterion.description} maxLength={250} onChange={(event) => updateDraft(index, "description", event.target.value)} /></label>
                  <div>
                    <label>Mínimo<input value={criterion.min_score} type="number" min="0" max="10" step="0.01" onChange={(event) => updateDraft(index, "min_score", event.target.value)} required /></label>
                    <label>Máximo<input value={criterion.max_score} type="number" min="0" max="10" step="0.01" onChange={(event) => updateDraft(index, "max_score", event.target.value)} required /></label>
                  </div>
                  <button type="button" className={styles.removeCriterion} disabled={criteriaDraft.length === 1} onClick={() => setCriteriaDraft((items) => items.filter((_, itemIndex) => itemIndex !== index))}>Remover</button>
                </fieldset>
              ))}
            </div>
            <div className={`${styles.modalActions} ${responsiveStyles.modalActions}`}>
              <button type="button" className={styles.outlineButton} disabled={criteriaDraft.length >= 12} onClick={() => setCriteriaDraft((items) => [...items, { name: "", description: "", min_score: "0", max_score: "10" }])}><Plus /> Adicionar critério</button>
              <div><button type="button" className={styles.cancelButton} onClick={() => setCriteriaCompetition(null)}>Cancelar</button><button className={styles.primaryButton} disabled={working === "criteria"}>{working === "criteria" ? <LoaderCircle /> : <Check />} Salvar critérios</button></div>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
