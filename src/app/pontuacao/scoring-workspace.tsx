"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Award,
  Check,
  ClipboardList,
  Clock,
  LoaderCircle,
  Music2,
  Pause,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Shuffle,
  Trophy,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import styles from "./scoring.module.css";
import responsiveStyles from "./scoring-responsive.module.css";
import controls from "./scoring-controls.module.css";

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
  timer_duration_seconds: number;
  timer_state: "idle" | "running" | "paused";
  timer_started_at: string | null;
  timer_ends_at: string | null;
  timer_remaining_seconds: number | null;
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

const DEFAULT_TIMER_SECONDS = 4 * 60;

function messageFrom(error: { message?: string } | null, fallback: string) {
  const message = error?.message || fallback;
  if (/assign at least (?:one|three) active judges?/i.test(message)) return "Atribua pelo menos 1 juiz ativo a esta categoria para iniciar a avaliação.";
  if (/wait for every active judge/i.test(message)) return "Aguarde todos os juízes ativos enviarem suas fichas antes de concluir.";
  if (/restart this evaluation/i.test(message)) return "Esta avaliação já possui notas. Use “Reiniciar avaliação” para apagar as fichas e voltar à fila.";
  if (/finish or restart the currently open/i.test(message)) return "Conclua ou reinicie a avaliação que já está aberta antes de abrir outro participante.";
  if (/published results/i.test(message)) return "Esta categoria já possui resultados publicados e não pode ser reiniciada.";
  if (/judge assignments are locked/i.test(message)) return "A escala de jurados desta categoria já começou. Para alterá-la, reinicie as avaliações concluídas e deixe todas na fila.";
  if (/return the presentation to the queue/i.test(message)) return "Volte a apresentação para a fila antes de abri-la novamente.";
  if (/order can only be drawn before the first presentation is opened/i.test(message)) return "A ordem só pode ser sorteada antes de anunciar a primeira pessoa.";
  if (/generate the presentation queue before drawing/i.test(message)) return "Gere a fila antes de sortear a ordem de apresentação.";
  return message;
}

function totalLabel(total: number | null) {
  if (total === null || Number.isNaN(Number(total))) return "Aguardando notas";
  return `${Number(total).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pontos`;
}

function clockLabel(value: number | null | undefined) {
  const seconds = Math.max(0, Math.round(Number(value ?? 0)));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
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
  const [restartTarget, setRestartTarget] = useState<Presentation | null>(null);
  const [restartError, setRestartError] = useState("");
  const [timerTarget, setTimerTarget] = useState<Presentation | null>(null);
  const [timerMinutes, setTimerMinutes] = useState("4");
  const [timerSeconds, setTimerSeconds] = useState("0");
  const [timerError, setTimerError] = useState("");
  const [shuffleTarget, setShuffleTarget] = useState<ScoringCategory | null>(null);
  const [shuffleError, setShuffleError] = useState("");

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
    const { error: statusError } = status === "live"
      ? await createClient().rpc("open_scoring_presentation", { target_presentation: presentation.id })
      : await createClient().rpc("set_scoring_presentation_status", {
        target_presentation: presentation.id,
        next_status: status,
      });
    if (statusError) {
      setError(messageFrom(statusError, "Não foi possível atualizar a apresentação."));
    } else {
      setNotice(status === "live" ? "Pessoa anunciada no telão. Clique em “Iniciar tempo” quando ela começar a cantar." : status === "finished" ? "Apresentação concluída." : "Abertura cancelada. A apresentação voltou para a fila sem apagar notas.");
      await Promise.all([loadWorkspace(selectedEventId), canJudge ? loadJudgeQueue() : Promise.resolve()]);
    }
    setWorking("");
  }

  function openShuffleDialog(category: ScoringCategory) {
    setShuffleError("");
    setError("");
    setNotice("");
    setShuffleTarget(category);
  }

  async function shufflePresentations() {
    if (!shuffleTarget) return;
    const workKey = `shuffle-${shuffleTarget.id}`;
    setWorking(workKey);
    setShuffleError("");
    const { data, error: shuffleRequestError } = await createClient().rpc("shuffle_scoring_presentations", {
      target_category: shuffleTarget.id,
    });
    if (shuffleRequestError) {
      setShuffleError(messageFrom(shuffleRequestError, "Não foi possível sortear a ordem de apresentação."));
    } else {
      const total = Number(data || 0);
      setShuffleTarget(null);
      setNotice(`Ordem sorteada com ${total} participante(s), sem repetição. A sequência fica bloqueada após anunciar a primeira pessoa.`);
      await loadWorkspace(selectedEventId);
    }
    setWorking("");
  }

  function openRestartDialog(presentation: Presentation) {
    setRestartError("");
    setError("");
    setNotice("");
    setRestartTarget(presentation);
  }

  async function restartPresentation() {
    if (!restartTarget) return;
    setWorking(`restart-${restartTarget.id}`);
    setRestartError("");
    const { data, error: restartRequestError } = await createClient().rpc("restart_scoring_presentation", {
      target_presentation: restartTarget.id,
    });
    if (restartRequestError) {
      setRestartError(messageFrom(restartRequestError, "Não foi possível reiniciar a avaliação."));
    } else {
      const result = data as { scorecards_deleted?: number; results_invalidated?: number } | null;
      const clearedScorecards = Number(result?.scorecards_deleted || 0);
      const clearedResults = Number(result?.results_invalidated || 0);
      setRestartTarget(null);
      setNotice(`Avaliação reiniciada. ${clearedScorecards} ficha(s) foram apagadas e a apresentação voltou para a fila.${clearedResults ? " A classificação anterior foi invalidada." : ""}`);
      await Promise.all([loadWorkspace(selectedEventId), canJudge ? loadJudgeQueue() : Promise.resolve()]);
    }
    setWorking("");
  }

  function openTimerDialog(presentation: Presentation) {
    const duration = Number(presentation.timer_duration_seconds || DEFAULT_TIMER_SECONDS);
    setTimerMinutes(String(Math.floor(duration / 60)));
    setTimerSeconds(String(duration % 60));
    setTimerError("");
    setError("");
    setNotice("");
    setTimerTarget(presentation);
  }

  async function managePresentationTimer(presentation: Presentation, action: "pause" | "resume" | "restart") {
    const workKey = `timer-${presentation.id}`;
    setWorking(workKey);
    setError("");
    const { error: timerRequestError } = await createClient().rpc("manage_scoring_presentation_timer", {
      target_presentation: presentation.id,
      action,
    });
    if (timerRequestError) {
      setError(messageFrom(timerRequestError, "Não foi possível atualizar o cronômetro."));
    } else {
      const notices = {
        pause: "Cronômetro pausado no telão.",
        resume: presentation.timer_started_at ? "Cronômetro retomado no telão." : "Cronômetro iniciado no telão.",
        restart: `Cronômetro reiniciado em ${clockLabel(presentation.timer_duration_seconds || DEFAULT_TIMER_SECONDS)}.`,
      };
      setNotice(notices[action]);
      await loadWorkspace(selectedEventId);
    }
    setWorking("");
  }

  async function savePresentationTimer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!timerTarget) return;
    const minutes = Number(timerMinutes);
    const seconds = Number(timerSeconds);
    const duration = minutes * 60 + seconds;
    if (!Number.isInteger(minutes) || !Number.isInteger(seconds) || minutes < 0 || seconds < 0 || seconds > 59 || duration < 30 || duration > 3600) {
      setTimerError("Informe um tempo entre 00:30 e 60:00.");
      return;
    }

    const workKey = `timer-${timerTarget.id}`;
    setWorking(workKey);
    setTimerError("");
    const { error: timerRequestError } = await createClient().rpc("manage_scoring_presentation_timer", {
      target_presentation: timerTarget.id,
      action: "set_duration",
      duration_seconds: duration,
    });
    if (timerRequestError) {
      setTimerError(messageFrom(timerRequestError, "Não foi possível salvar o tempo."));
    } else {
      setTimerTarget(null);
      setNotice(timerTarget.status === "live"
        ? timerTarget.timer_state === "paused"
          ? `Tempo ajustado para ${clockLabel(duration)}. O cronômetro continua pausado.`
          : `Tempo ajustado para ${clockLabel(duration)} e cronômetro reiniciado.`
        : `Tempo de ${clockLabel(duration)} definido para esta apresentação.`);
      await loadWorkspace(selectedEventId);
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
                            <small className={category.active_judges ? controls.judgeReady : controls.judgeRequired}>
                              {category.active_judges ? `Pronta para iniciar com ${category.active_judges} juiz(es) ativo(s).` : "Atribua ao menos 1 juiz ativo para abrir a avaliação."}
                            </small>
                            {category.presentations.some((presentation) => presentation.status !== "waiting") && (
                              <small className={controls.judgeScaleHint}>Para preservar a classificação, mantenha a escala de jurados desta categoria até finalizá-la.</small>
                            )}
                          </div>
                          <div className={`${styles.categoryActions} ${responsiveStyles.categoryActions}`}>
                            <button
                              className={`${styles.outlineButton} ${controls.shuffleButton} ${responsiveStyles.outlineButton}`}
                              disabled={!category.presentations.length || category.presentations.some((presentation) => presentation.status !== "waiting" || presentation.submitted_scorecards > 0) || Boolean(working)}
                              onClick={() => openShuffleDialog(category)}
                              title="Sorteia uma sequência única antes de iniciar a primeira apresentação"
                            >
                              <Shuffle /> Sortear ordem
                            </button>
                            <button
                              className={`${styles.outlineButton} ${responsiveStyles.outlineButton}`}
                              disabled={!competition.criteria.length || !category.registration_count || working === `presentations-${category.id}`}
                              onClick={() => void generatePresentations(category)}
                            >
                              {working === `presentations-${category.id}` ? <LoaderCircle /> : <ClipboardList />} Gerar fila
                            </button>
                            <button
                              className={`${styles.primaryButton} ${responsiveStyles.primaryButton}`}
                              disabled={!category.presentations.length || category.active_judges < 1 || category.presentations.some((presentation) => presentation.status !== "finished") || working === `results-${category.id}`}
                              onClick={() => void generateResults(category)}
                            >
                              {working === `results-${category.id}` ? <LoaderCircle /> : <Trophy />} Gerar classificação
                            </button>
                          </div>
                        </div>

                        {category.presentations.length ? (
                          <ol className={`${styles.presentationList} ${responsiveStyles.presentationList}`}>
                            {category.presentations.map((presentation) => {
                              const canFinish = category.active_judges > 0 && presentation.submitted_scorecards >= category.active_judges;
                              const needsRestart = presentation.submitted_scorecards > 0;
                              const configuredTime = presentation.timer_duration_seconds || DEFAULT_TIMER_SECONDS;
                              const timerIsPaused = presentation.timer_state === "paused";
                              const timerWaitingToStart = timerIsPaused && !presentation.timer_started_at;
                              return (
                                <li key={presentation.id}>
                                  <div className={styles.queueNumber}>{presentation.sort_order}</div>
                                  <div className={`${styles.presentationName} ${responsiveStyles.presentationName}`}>
                                    <strong>{presentation.participant_name}</strong>
                                    <span className={controls.timerSummary}>
                                      {presentation.status === "live" && timerWaitingToStart
                                        ? `Pronto para iniciar · ${clockLabel(presentation.timer_remaining_seconds ?? configuredTime)}`
                                        : presentation.status === "live" && timerIsPaused
                                          ? `Tempo pausado · ${clockLabel(presentation.timer_remaining_seconds)}`
                                          : presentation.status === "live"
                                            ? "Cronômetro em andamento"
                                            : `Tempo: ${clockLabel(configuredTime)}`}
                                    </span>
                                    <span>{presentation.submitted_scorecards}/{category.active_judges} ficha(s) enviada(s) · {totalLabel(presentation.total_score)}</span>
                                  </div>
                                  <span className={`${styles.status} ${styles[presentation.status]}`}>{presentationStatus[presentation.status]}</span>
                                  <div className={`${styles.presentationActions} ${controls.presentationActions} ${responsiveStyles.presentationActions}`}>
                                    {presentation.status === "waiting" && !needsRestart && (
                                      <button disabled={Boolean(working) || category.active_judges < 1} onClick={() => void changePresentationStatus(presentation, "live")}><Play /> Chamar no telão</button>
                                    )}
                                    {presentation.status === "waiting" && !needsRestart && (
                                      <button className={controls.timerEditButton} disabled={Boolean(working)} onClick={() => openTimerDialog(presentation)}><Clock /> Ajustar tempo</button>
                                    )}
                                    {presentation.status === "live" && (
                                      <button disabled={Boolean(working) || !canFinish} onClick={() => void changePresentationStatus(presentation, "finished")}><Check /> Concluir</button>
                                    )}
                                    {presentation.status === "live" && (
                                      <button className={controls.pauseTimerButton} disabled={Boolean(working)} onClick={() => void managePresentationTimer(presentation, timerIsPaused ? "resume" : "pause")}>
                                        {timerIsPaused ? <Play /> : <Pause />}{timerWaitingToStart ? "Iniciar tempo" : timerIsPaused ? "Retomar tempo" : "Pausar tempo"}
                                      </button>
                                    )}
                                    {presentation.status === "live" && (
                                      <button className={controls.restartTimerButton} disabled={Boolean(working)} onClick={() => void managePresentationTimer(presentation, "restart")}><RotateCcw /> Reiniciar tempo</button>
                                    )}
                                    {presentation.status === "live" && (
                                      <button className={controls.timerEditButton} disabled={Boolean(working)} onClick={() => openTimerDialog(presentation)}><Clock /> Ajustar tempo</button>
                                    )}
                                    {presentation.status === "live" && !needsRestart && (
                                      <button className={controls.cancelPresentationButton} disabled={Boolean(working)} onClick={() => void changePresentationStatus(presentation, "waiting")}><X /> Cancelar abertura</button>
                                    )}
                                    {(presentation.status === "finished" || needsRestart) && (
                                      <button className={controls.restartButton} disabled={Boolean(working)} onClick={() => openRestartDialog(presentation)}><RotateCcw /> Reiniciar avaliação</button>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
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

      {shuffleTarget && (
        <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-labelledby="shuffle-modal-title">
          <button className={styles.modalBackdrop} type="button" disabled={working === `shuffle-${shuffleTarget.id}`} onClick={() => setShuffleTarget(null)} aria-label="Fechar confirmação de sorteio" />
          <section className={`${styles.criteriaModal} ${controls.shuffleModal} ${responsiveStyles.criteriaModal}`}>
            <div className={styles.modalHeading}>
              <div>
                <span className="eyebrow">ORDEM DE APRESENTAÇÃO</span>
                <h2 id="shuffle-modal-title">Sortear {shuffleTarget.name}?</h2>
                <p>Será criada uma sequência única para toda a categoria, do primeiro ao último cantor.</p>
              </div>
              <button type="button" className={styles.iconButton} disabled={working === `shuffle-${shuffleTarget.id}`} onClick={() => setShuffleTarget(null)} aria-label="Fechar"><X /></button>
            </div>
            <div className={controls.shuffleSummary}>
              <strong>{shuffleTarget.presentations.length} participante(s) entrarão no sorteio.</strong>
              <span>Ninguém será repetido. Depois que a primeira pessoa for anunciada no telão, a ordem ficará bloqueada para manter o sorteio transparente.</span>
            </div>
            {shuffleError && <div className="form-error" role="alert">{shuffleError}</div>}
            <div className={styles.modalActions}>
              <span />
              <div>
                <button type="button" className={styles.cancelButton} disabled={working === `shuffle-${shuffleTarget.id}`} onClick={() => setShuffleTarget(null)}>Voltar</button>
                <button type="button" className={controls.shuffleConfirmButton} disabled={working === `shuffle-${shuffleTarget.id}`} onClick={() => void shufflePresentations()}><Shuffle />{working === `shuffle-${shuffleTarget.id}` ? "Sorteando..." : "Sortear agora"}</button>
              </div>
            </div>
          </section>
        </div>
      )}

      {timerTarget && (
        <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-labelledby="timer-modal-title">
          <button className={styles.modalBackdrop} type="button" disabled={working === `timer-${timerTarget.id}`} onClick={() => setTimerTarget(null)} aria-label="Fechar ajuste de tempo" />
          <form className={`${styles.criteriaModal} ${controls.timerModal} ${responsiveStyles.criteriaModal}`} onSubmit={(event) => void savePresentationTimer(event)}>
            <div className={styles.modalHeading}>
              <div>
                <span className="eyebrow">CRONÔMETRO DA APRESENTAÇÃO</span>
                <h2 id="timer-modal-title">Ajustar tempo de {timerTarget.participant_name}</h2>
                <p>O padrão é 4 minutos. Ao alterar o tempo de uma apresentação aberta, a contagem recomeça com o novo valor no telão.</p>
              </div>
              <button type="button" className={styles.iconButton} disabled={working === `timer-${timerTarget.id}`} onClick={() => setTimerTarget(null)} aria-label="Fechar"><X /></button>
            </div>
            <div className={controls.timerFields}>
              <label>Minutos<input value={timerMinutes} onChange={(event) => setTimerMinutes(event.target.value)} type="number" min="0" max="60" inputMode="numeric" required autoFocus /></label>
              <label>Segundos<input value={timerSeconds} onChange={(event) => setTimerSeconds(event.target.value)} type="number" min="0" max="59" inputMode="numeric" required /></label>
            </div>
            <p className={controls.timerHint}>Permitido de 00:30 até 60:00. Pausar não encerra a avaliação nem bloqueia os jurados.</p>
            {timerError && <div className="form-error" role="alert">{timerError}</div>}
            <div className={styles.modalActions}>
              <span />
              <div>
                <button type="button" className={styles.cancelButton} disabled={working === `timer-${timerTarget.id}`} onClick={() => setTimerTarget(null)}>Cancelar</button>
                <button className={controls.timerSaveButton} disabled={working === `timer-${timerTarget.id}`}><Clock />{working === `timer-${timerTarget.id}` ? "Salvando..." : "Aplicar tempo"}</button>
              </div>
            </div>
          </form>
        </div>
      )}

      {restartTarget && (
        <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-labelledby="restart-modal-title">
          <button className={styles.modalBackdrop} type="button" disabled={working === `restart-${restartTarget.id}`} onClick={() => setRestartTarget(null)} aria-label="Fechar confirmação" />
          <section className={`${styles.criteriaModal} ${controls.restartModal} ${responsiveStyles.criteriaModal}`}>
            <div className={styles.modalHeading}>
              <div>
                <span className="eyebrow">REINICIAR AVALIAÇÃO</span>
                <h2 id="restart-modal-title">Reiniciar {restartTarget.participant_name}?</h2>
                <p>Esta ação apaga as fichas já enviadas, devolve a apresentação para a fila e permite abrir novamente para os jurados.</p>
              </div>
              <button type="button" className={styles.iconButton} disabled={working === `restart-${restartTarget.id}`} onClick={() => setRestartTarget(null)} aria-label="Fechar"><X /></button>
            </div>
            <div className={controls.restartSummary}>
              <strong>{restartTarget.submitted_scorecards} ficha(s) serão apagadas.</strong>
              <span>Se já houver uma classificação não publicada nesta categoria, ela será removida e poderá ser gerada novamente. Resultados publicados não podem ser reiniciados.</span>
            </div>
            {restartError && <div className="form-error" role="alert">{restartError}</div>}
            <div className={styles.modalActions}>
              <span />
              <div>
                <button type="button" className={styles.cancelButton} disabled={working === `restart-${restartTarget.id}`} onClick={() => setRestartTarget(null)}>Voltar</button>
                <button type="button" className={controls.dangerButton} disabled={working === `restart-${restartTarget.id}`} onClick={() => void restartPresentation()}><RotateCcw />{working === `restart-${restartTarget.id}` ? "Reiniciando..." : "Reiniciar e apagar notas"}</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
