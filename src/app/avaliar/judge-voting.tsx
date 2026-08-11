"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, CircleDot, Gavel, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type FlagColor = "blue" | "green";

type LiveMatch = {
  match_id: string;
  assignment_id: string;
  ring_name: string;
  category_name: string;
  phase: string;
  blue_registration_id: string;
  blue_name: string;
  green_registration_id: string;
  green_name: string;
  voted: boolean;
};

type VoteSelection = {
  matchId: string;
  color: FlagColor;
};

function formatTime(date: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function candidateName(match: LiveMatch, color: FlagColor) {
  const name = color === "blue" ? match.blue_name : match.green_name;
  return name || `Competidor ${color === "blue" ? "azul" : "verde"}`;
}

function voteErrorMessage(message: string, code?: string) {
  if (code === "23505") return "Seu voto para este confronto já foi registrado.";
  if (/row-level security|permission denied/i.test(message)) {
    return "Seu acesso a esta votação não está liberado. Peça ao administrador para conferir sua designação.";
  }
  return "Não foi possível registrar o voto agora. Confira a conexão e tente novamente.";
}

export default function JudgeVoting({ initialMatches, loadError }: { initialMatches: LiveMatch[]; loadError: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [matches, setMatches] = useState(initialMatches);
  const [error, setError] = useState(loadError);
  const [selection, setSelection] = useState<VoteSelection | null>(null);
  const [savingMatchId, setSavingMatchId] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const pendingCount = matches.filter((match) => !match.voted).length;

  const refreshMatches = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    if (!silent) setError("");

    const { data, error: refreshError } = await supabase.rpc("judge_live_matches");

    if (refreshError) {
      if (!silent) setError("Não foi possível atualizar as disputas agora. Tente novamente em alguns segundos.");
      if (!silent) setRefreshing(false);
      return;
    }

    const nextMatches = (data || []) as LiveMatch[];
    setMatches(nextMatches);
    setSelection((current) => current && nextMatches.some((match) => match.match_id === current.matchId && !match.voted) ? current : null);
    setLastUpdated(new Date());
    if (!silent) setRefreshing(false);
  }, [supabase]);

  useEffect(() => {
    const refreshTimer = window.setInterval(() => {
      void refreshMatches(true);
    }, 15000);

    return () => window.clearInterval(refreshTimer);
  }, [refreshMatches]);

  function selectWinner(match: LiveMatch, color: FlagColor) {
    if (match.voted || savingMatchId) return;
    setError("");
    setSelection({ matchId: match.match_id, color });
  }

  async function confirmVote(match: LiveMatch) {
    if (!selection || selection.matchId !== match.match_id) return;

    setError("");
    setSavingMatchId(match.match_id);

    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      setError("Sua sessão não está mais ativa. Entre novamente para registrar o voto.");
      setSavingMatchId("");
      return;
    }

    const chosenRegistrationId = selection.color === "blue"
      ? match.blue_registration_id
      : match.green_registration_id;

    const { error: insertError } = await supabase
      .from("flag_votes")
      .insert({
        match_id: match.match_id,
        judge_id: authData.user.id,
        assignment_id: match.assignment_id,
        chosen_registration_id: chosenRegistrationId,
        color: selection.color,
      });

    if (insertError) {
      setError(voteErrorMessage(insertError.message, insertError.code));
      setSavingMatchId("");
      return;
    }

    setMatches((items) => items.map((item) => item.match_id === match.match_id ? { ...item, voted: true } : item));
    setSelection(null);
    setSavingMatchId("");
    setLastUpdated(new Date());
  }

  return (
    <main className="judge-page">
      <header className="judge-header">
        <div className="judge-heading">
          <span className="eyebrow">PAINEL DO JUIZ</span>
          <h1>Avaliações ao vivo</h1>
          <p>Escolha o vencedor somente após o encerramento da disputa.</p>
        </div>

        <div className="judge-header-actions">
          <Link className="secondary judge-action-link" href="/pontuacao">
            Notas Cante Comigo <ChevronRight aria-hidden="true" />
          </Link>
          <button className="secondary judge-refresh-button" type="button" onClick={() => void refreshMatches()} disabled={refreshing}>
            {refreshing ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {refreshing ? "Atualizando" : "Atualizar"}
          </button>
        </div>
      </header>

      <section className="judge-live-summary" aria-live="polite">
        <CircleDot aria-hidden="true" />
        <div>
          <strong>{pendingCount === 1 ? "1 disputa aguardando seu voto" : `${pendingCount} disputas aguardando seu voto`}</strong>
          <span>{refreshing ? "Buscando atualizações…" : lastUpdated ? `Atualizado às ${formatTime(lastUpdated)} · atualização automática ativa` : "Dados carregados · atualização automática ativa"}</span>
        </div>
      </section>

      {error && <div className="form-error judge-error" role="alert">{error}</div>}

      {matches.length ? (
        <section className="vote-grid" aria-label="Disputas disponíveis para votação">
          {matches.map((match) => {
            const selectedColor = selection?.matchId === match.match_id ? selection.color : null;
            const isSaving = savingMatchId === match.match_id;
            const selectedName = selectedColor ? candidateName(match, selectedColor) : "";

            return (
              <article key={match.match_id} className={`vote-card${match.voted ? " voted" : ""}${isSaving ? " is-saving" : ""}`}>
                <div className="vote-meta">
                  <span className="vote-context">{match.ring_name} <i aria-hidden="true">·</i> {match.category_name}</span>
                  <b>{match.phase}</b>
                </div>

                <div className="vote-card-heading">
                  <span>VOTAÇÃO ABERTA</span>
                  <h2>Escolha o vencedor</h2>
                  <p>Toque em um competidor e confirme a escolha.</p>
                </div>

                <div className="vote-options" aria-label={`Competidores de ${match.category_name}`}>
                  {(["blue", "green"] as const).map((color) => {
                    const isSelected = selectedColor === color;
                    const displayName = candidateName(match, color);
                    const colorLabel = color === "blue" ? "Bandeira azul" : "Bandeira verde";

                    return (
                      <button
                        key={color}
                        className={`competitor-option ${color}${isSelected ? " selected" : ""}`}
                        type="button"
                        disabled={match.voted || Boolean(savingMatchId)}
                        aria-pressed={isSelected}
                        onClick={() => selectWinner(match, color)}
                      >
                        <span className="competitor-flag" aria-hidden="true" />
                        <span className="competitor-copy">
                          <small>{colorLabel}</small>
                          <strong>{displayName}</strong>
                        </span>
                        {isSelected && <Check className="competitor-check" aria-label="Selecionado" />}
                        {!isSelected && <ChevronRight className="competitor-arrow" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>

                {match.voted ? (
                  <div className="vote-confirmed" role="status"><Check aria-hidden="true" /> Voto registrado com sucesso</div>
                ) : selectedColor ? (
                  <div className="vote-confirmation">
                    <div>
                      <ShieldCheck aria-hidden="true" />
                      <span>Confirmar voto em <strong>{selectedName}</strong></span>
                    </div>
                    <div className="vote-confirmation-actions">
                      <button className="judge-change-choice" type="button" onClick={() => setSelection(null)} disabled={isSaving}>Trocar</button>
                      <button className="judge-confirm-vote" type="button" onClick={() => void confirmVote(match)} disabled={isSaving}>
                        {isSaving ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Check aria-hidden="true" />}
                        {isSaving ? "Registrando…" : "Confirmar voto"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="vote-guidance"><ShieldCheck aria-hidden="true" /> Seu voto é individual e não pode ser alterado após a confirmação.</p>
                )}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="judge-empty">
          <Gavel aria-hidden="true" />
          <span className="eyebrow">PAINEL PRONTO</span>
          <h2>Nenhuma disputa aguardando seu voto</h2>
          <p>Quando um confronto da sua roda for iniciado, ele aparecerá aqui automaticamente.</p>
          <div className="judge-empty-actions">
            <button className="secondary judge-refresh-button" type="button" onClick={() => void refreshMatches()} disabled={refreshing}>
              {refreshing ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              Atualizar agora
            </button>
            <Link className="primary judge-empty-link" href="/pontuacao">Abrir avaliações Cante Comigo</Link>
          </div>
        </section>
      )}
    </main>
  );
}
