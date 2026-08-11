"use client";

import Image from "next/image";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Radio, Trophy, Users } from "lucide-react";

type Board = {
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
};

export default function PublicDisplay({ board, pin }: { board: Board; pin: string }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 8000);
    return () => window.clearInterval(timer);
  }, [router]);

  const live = board.match_status === "live";
  const finished = board.match_status === "finished";
  const hasMatch = Boolean(board.blue_name && board.green_name);
  const received = board.votes_received || 0;
  const required = board.judges_required || 0;

  return (
    <main className="public-display">
      <header>
        <Image className="display-logo-image" src="/brand/capoeira-arte-luta-brasil.png" alt="Logo Capoeira Arte-Luta Brasil" width={1536} height={1024} priority />
        <div className="display-event-title"><span>CAMPEONATO AO VIVO</span><h1>{board.event_name}</h1></div>
        <div className="display-session"><Radio /> {live ? "AO VIVO" : "TELÃO"}<small>{board.ring_name || board.session_name}</small></div>
      </header>

      {hasMatch ? (
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
        <section className="display-idle"><Radio /><h2>Aguardando a próxima disputa</h2><p>O telão será atualizado automaticamente assim que um confronto for iniciado.</p></section>
      )}
      <footer>Sessão {pin} · atualização automática</footer>
    </main>
  );
}
