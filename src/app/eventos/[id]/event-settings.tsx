"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Settings2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const statuses = [
  { id: "draft", name: "Rascunho" }, { id: "registration_open", name: "Inscrições abertas" },
  { id: "registration_closed", name: "Inscrições encerradas" }, { id: "preparing", name: "Preparação" },
  { id: "live", name: "Em andamento" },
];

export default function EventSettings({ eventId, initialSettings, initialStatus }: {
  eventId: string; initialSettings: Record<string, unknown>; initialStatus: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [requirePayment, setRequirePayment] = useState(initialSettings.require_payment === true);
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const closed = initialStatus === "finished";
  async function save() {
    if (loading || closed) return;
    setLoading(true); setError("");
    try {
      const { data, error: updateError } = await createClient().from("events")
        .update({ status, settings: { ...initialSettings, require_payment: requirePayment } })
        .eq("id", eventId).neq("status", "finished").select("id").single();
      if (updateError || !data) {
        setError("Não foi possível salvar. Confira a conexão, suas permissões e se o evento já foi finalizado.");
        return;
      }
      setOpen(false); router.refresh();
    } catch { setError("A conexão foi interrompida. Confira o estado do evento antes de repetir a operação."); }
    finally { setLoading(false); }
  }
  function show() {
    setStatus(initialStatus); setRequirePayment(initialSettings.require_payment === true); setError(""); setOpen(true);
  }
  return <><button type="button" className="secondary" onClick={show}><Settings2 />Configurações</button>
    {open && <div className="modal-wrap">
      <button className="backdrop" type="button" disabled={loading} onClick={() => setOpen(false)} aria-label="Fechar" />
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="event-settings-title">
        <button className="modal-x" type="button" disabled={loading} onClick={() => setOpen(false)} aria-label="Fechar configurações"><X /></button>
        <span className="eyebrow">CONFIGURAÇÕES DO EVENTO</span><h2 id="event-settings-title">Operação e credenciamento</h2>
        {closed && <p className="event-closed-notice">Este evento está finalizado. Os dados do encerramento e o relatório foram preservados; não é possível reabrir ou alterar suas configurações.</p>}
        <label>Status do evento<select disabled={loading || closed} value={status} onChange={(event) => setStatus(event.target.value)}>
          {closed && <option value="finished">Finalizado</option>}{statuses.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>
        <label className="toggle-setting"><input type="checkbox" disabled={loading || closed} checked={requirePayment} onChange={(event) => setRequirePayment(event.target.checked)} />
          <span><b>Exigir confirmação de pagamento</b><small>Quando desligado, o check-in mostra somente a presença dos participantes.</small></span>
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary" disabled={loading} onClick={() => setOpen(false)}>{closed ? "Fechar" : "Cancelar"}</button>
          {!closed && <button type="button" className="primary" disabled={loading} onClick={() => void save()}>{loading ? "Salvando..." : "Salvar"}</button>}
        </div>
      </section>
    </div>}
  </>;
}
