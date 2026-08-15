"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Music2, Radio, Trophy, Users } from "lucide-react";

type Board = {
  display_kind?: "match" | "scoring" | "idle";
  session_name: string;
  event_name: string;
  ring_name: string | null;
  match_status: string | null;
  phase: string | null;
  blue_name: string | null;
  green_name: string | null;
  blue_votes?: number;
  green_votes?: number;
  votes_received?: number;
  judges_required?: number;
  winner_name: string | null;
  competition_name?: string | null;
  category_name?: string | null;
  participant_name?: string | null;
  participant_age?: string | null;
  song_title?: string | null;
  song_author?: string | null;
  presentation_status?: "waiting" | "live" | "finished" | null;
  queue_position?: number | null;
  scorecards_received?: number;
  total_score?: number | string | null;
  timer_duration_seconds?: number | null;
  timer_state?: "idle" | "running" | "paused" | null;
  timer_started_at?: string | null;
  timer_ends_at?: string | null;
  timer_remaining_seconds?: number | null;
  server_now?: string | null;
};

function countdownLabel(value: number) {
  const seconds = Math.max(0, Math.ceil(value));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export default function PublicDisplay({ board, pin }: { board: Board; pin: string }) {
  const router = useRouter();
  const [clock, setClock] = useState<{ now: number; serverOffset: number } | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 3500);
    return () => window.clearInterval(timer);
  }, [router]);

  useEffect(() => {
    const serverNow = Date.parse(board.server_now || "");
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock({ now, serverOffset: Number.isFinite(serverNow) ? now - serverNow : 0 });
    }, 250);
    return () => window.clearInterval(timer);
  }, [board.server_now]);

  const live = board.match_status === "live";
  const finished = board.match_status === "finished";
  const hasMatch = Boolean(board.blue_name && board.green_name);
  const isScoring = board.display_kind === "scoring" && Boolean(board.participant_name);
  const scoringLive = board.presentation_status === "live";
  const scoringFinished = board.presentation_status === "finished";
  const received = board.votes_received || 0;
  const required = board.judges_required || 0;
  const scorecardsReceived = board.scorecards_received || 0;
  const scoreTotal = board.total_score === null || board.total_score === undefined || Number.isNaN(Number(board.total_score))
    ? null
    : Number(board.total_score).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const timerDuration = Math.max(30, Number(board.timer_duration_seconds || 4 * 60));
  const timerState = board.timer_state || "running";
  const timerEndsAt = Date.parse(board.timer_ends_at || "");
  const storedTimerRemaining = Math.max(0, Number(board.timer_remaining_seconds ?? timerDuration));
  const syncedNow = clock === null ? null : clock.now - clock.serverOffset;
  const timerRemaining = timerState === "paused" || !Number.isFinite(timerEndsAt) || syncedNow === null
    ? storedTimerRemaining
    : Math.max(0, Math.ceil((timerEndsAt - syncedNow) / 1000));
  const timerExpired = timerRemaining <= 0;
  const timerWaitingToStart = timerState === "paused" && !board.timer_started_at;

  return (
    <main className="public-display public-display--fullscreen">
      <header>
        <Image className="display-logo-image" src="/brand/capoeira-arte-luta-brasil.png" alt="Logo Capoeira Arte-Luta Brasil" width={1536} height={1024} priority />
        <div className="display-event-title"><span>{isScoring ? "MUSICALIDADE AO VIVO" : "CAMPEONATO AO VIVO"}</span><h1>{board.event_name}</h1></div>
        <div className="display-session"><Radio /> {isScoring && scoringLive ? timerWaitingToStart ? "PRÓXIMO" : "AO VIVO" : live ? "AO VIVO" : "TELÃO"}<small>{isScoring ? board.competition_name || board.session_name : board.ring_name || board.session_name}</small></div>
      </header>

      {isScoring ? (
        <section className="display-scoring">
          <div className="display-scoring-status"><Music2 />{scoringLive ? timerWaitingToStart ? "PRÓXIMO A CANTAR" : "APRESENTAÇÃO EM AVALIAÇÃO" : "ÚLTIMA APRESENTAÇÃO CONCLUÍDA"}</div>
          <p className="display-scoring-category">{[board.competition_name, board.category_name].filter(Boolean).join(" · ") || "Cante Comigo Capoeira"}</p>
          {scoringLive && (
            <div className={`display-scoring-timer ${timerExpired ? "is-expired" : ""}`} aria-label={`Tempo ${timerExpired ? "encerrado" : timerWaitingToStart ? "aguardando início" : timerState === "paused" ? "pausado" : "restante"}: ${countdownLabel(timerRemaining)}`}>
              <span><Clock />{timerExpired ? "TEMPO ENCERRADO" : timerWaitingToStart ? "PRONTO PARA CANTAR · AGUARDANDO INÍCIO" : timerState === "paused" ? "TEMPO PAUSADO" : "TEMPO RESTANTE"}</span>
              <b>{countdownLabel(timerRemaining)}</b>
            </div>
          )}
          <h2>{board.participant_name}</h2>
          {scoringFinished ? (
            <div className="display-scoring-final"><Trophy /><span>PONTUAÇÃO FINAL</span><b>{scoreTotal ?? "—"}</b><small>PONTOS</small></div>
          ) : (
            <>
              <div className="display-scoring-info">
                <div><span>IDADE</span><strong>{board.participant_age ? `${board.participant_age} anos` : "Não informada"}</strong></div>
                <div><span>MÚSICA</span><strong>{board.song_title || "Música não informada"}</strong></div>
                <div><span>AUTOR / INTÉRPRETE</span><strong>{board.song_author || "Autor não informado"}</strong></div>
              </div>
              <p className="display-scoring-progress"><Users />Notas em andamento{required ? ` · ${scorecardsReceived} de ${required} fichas recebidas` : ""}</p>
            </>
          )}
        </section>
      ) : hasMatch ? (
        <section className="display-match">
          <div className="display-phase">{board.phase || "Confronto"}</div>
          <div className="display-fighters">
            <article className="blue"><span>COMPETIDOR AZUL</span><strong>{board.blue_name}</strong>{finished && <b>{board.blue_votes || 0}</b>}</article>
            <i>×</i>
            <article className="green"><span>COMPETIDOR VERDE</span><strong>{board.green_name}</strong>{finished && <b>{board.green_votes || 0}</b>}</article>
          </div>
          {board.winner_name
            ? <div className="display-winner"><Trophy /> Vencedor: <b>{board.winner_name}</b></div>
            : <p>{live ? <><Users /> Votação em andamento{required ? ` · ${received} de ${required} votos recebidos` : ""}</> : "Aguardando início do confronto"}</p>}
        </section>
      ) : (
        <section className="display-idle"><Radio /><h2>Aguardando a próxima apresentação ou disputa</h2><p>O telão será atualizado automaticamente quando uma apresentação ou confronto for iniciado.</p></section>
      )}
      <footer>Sessão {pin} · atualização automática</footer>
    </main>
  );
}
