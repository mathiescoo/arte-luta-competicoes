"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function EventClosure({ eventId, eventName, hasReport, existingFinished = false }: { eventId: string; eventName: string; hasReport: boolean; existingFinished?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function close() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/eventos/${eventId}/relatorio`, { method: "POST" });
      if (!response.ok) {
        const payload = await response.json();
        setError(payload.error || "Não foi possível finalizar o evento.");
        router.refresh();
      } else {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a"); link.href = url; link.download = `relatorio-evento-${eventId}.pdf`; link.click();
        URL.revokeObjectURL(url); setOpen(false); router.refresh();
      }
    } catch { setError("Não foi possível verificar o resultado. Atualize a página antes de tentar novamente."); }
    setBusy(false);
  }
  return <section className="category-workspace"><div className="category-toolbar"><div><span className="eyebrow">ENCERRAMENTO</span><h2>Relatório e prestação de contas</h2><p>O relatório guarda os dados registrados no momento do encerramento, incluindo fichas e votos.</p></div></div>
    {hasReport ? <a className="primary" href={`/api/eventos/${eventId}/relatorio`}>Baixar relatório em PDF</a> : <button className="primary" type="button" onClick={() => setOpen(true)}>{existingFinished ? "Gerar histórico e PDF" : "Finalizar evento e gerar PDF"}</button>}
    {open && <div className="modal-wrap"><button className="backdrop" type="button" aria-label="Fechar" onClick={() => setOpen(false)} disabled={busy} /><section className="modal event-settings-modal" role="dialog" aria-modal="true" aria-labelledby="close-event-title"><h2 id="close-event-title">Finalizar {eventName}?</h2><p>Será criado um registro permanente com as inscrições, notas, votos e resultados já registrados. O evento será marcado como finalizado. Verifique os dados antes de confirmar.</p><p>Apresentações e confrontos em aberto precisam ser concluídos antes do encerramento. Os telões do evento serão desativados.</p><p>Se desejar incluir receitas e despesas, volte e salve os valores em Configurações do evento antes de finalizar. Depois do encerramento, o registro não pode ser alterado.</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="secondary" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancelar</button><button className="primary" type="button" disabled={busy} onClick={() => void close()}>{busy ? "Gerando relatório..." : "Finalizar e salvar PDF"}</button></div></section></div>}
  </section>;
}
