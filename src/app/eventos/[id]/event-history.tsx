import type { Snapshot } from "@/lib/event-report-pdf";
import { formatAmount } from "@/lib/financial";

function label(value: unknown, fallback = "Não informado") {
  return value === null || value === undefined || String(value).trim() === "" ? fallback : String(value);
}

export default function EventHistory({ eventId, snapshot }: { eventId: string; snapshot: Snapshot }) {
  const { registrations = [], results = [], scorecards = [], matches = [] } = snapshot;
  const finance = snapshot.event.financial && typeof snapshot.event.financial === "object" ? snapshot.event.financial as Record<string, unknown> : {};
  return <section className="event-history">
    <h2>Histórico preservado</h2><p>Os dados abaixo são uma cópia do momento do encerramento e não podem ser alterados por esta tela.</p>
    <div className="recovery-actions"><a className="primary" href={`/api/eventos/${eventId}/relatorio`}>Baixar relatório organizado em PDF</a><a className="secondary" href={`/api/eventos/${eventId}/relatorio?original=1`}>Baixar PDF original</a></div>
    <details><summary>Prestação de contas</summary><p>Receitas informadas: {formatAmount(finance.income_cents)}<br />Despesas informadas: {formatAmount(finance.expenses_cents)}{finance.notes ? <><br />Observações: {label(finance.notes)}</> : null}</p><p>Valores declarados manualmente pela organização; o sistema não processa pagamentos nem verifica comprovantes.</p></details>
    <details><summary>Participantes e inscrições ({registrations.length})</summary>
      {registrations.map((item, i) => <p key={i}><strong>{label(item.name)}</strong> — {label(item.competition)} · {label(item.category)} · Idade: {label(item.age)}{item.song ? ` · Música: ${label(item.song)} · Autor: ${label(item.author)}` : ""}</p>)}
    </details>
    <details><summary>Classificações ({results.length})</summary>
      {results.map((item, i) => <p key={i}><strong>{label(item.competition)} · {label(item.category)}</strong> — {label(item.position, "-")}º {label(item.name)}{item.total !== null && item.total !== undefined ? ` · Pontuação: ${label(item.total)}` : ""}</p>)}
    </details>
    <details><summary>Fichas e notas dos juízes ({scorecards.length})</summary>
      {scorecards.map((card, i) => <article key={i}><p><strong>{label(card.name)}</strong> — {label(card.competition)} · {label(card.category)}<br />Jurado: {label(card.judge)} · Média: {label(card.average)}</p>
        <ul>{(Array.isArray(card.criteria) ? card.criteria as Record<string, unknown>[] : []).map((criterion, j) => <li key={j}>{label(criterion.name)}: {label(criterion.score)} ({label(criterion.minimum)} a {label(criterion.maximum)})</li>)}</ul>
        {card.note ? <p>Observação: {label(card.note)}</p> : null}{card.admin_edit_reason ? <p>Correção administrativa: {label(card.admin_edit_reason)}</p> : null}
      </article>)}
    </details>
    <details><summary>Confrontos e votos ({matches.length})</summary>
      {matches.map((match, i) => <article key={i}><p><strong>{label(match.competition)} · {label(match.category)}</strong> — {label(match.phase)}<br />Azul: {label(match.blue)} · Verde: {label(match.green)} · Vencedor: {label(match.winner)}</p>
        <ul>{(Array.isArray(match.votes) ? match.votes as Record<string, unknown>[] : []).map((vote, j) => <li key={j}>{label(vote.judge)}: {vote.color === "blue" ? "azul" : vote.color === "green" ? "verde" : "não informado"}</li>)}</ul>
      </article>)}
    </details>
  </section>;
}
