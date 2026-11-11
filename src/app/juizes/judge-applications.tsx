"use client";

import { useState } from "react";
import { Check, Clock3, ShieldX, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Application = {
  id: string;
  full_name: string;
  email: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  user_id: string;
};

export default function JudgeApplications({ organizationId, initialApplications }: { organizationId: string; initialApplications: Application[] }) {
  const [applications, setApplications] = useState(initialApplications);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<Application | null>(null);

  async function revoke(application: Application) {
    setError(""); setWorking(application.id);
    try {
      const { error: revokeError } = await createClient().rpc("manage_organization_access", {
        target_user: application.user_id, target_organization: organizationId, target_role: "judge", enabled: false,
      });
      if (revokeError) {
        setError(/judge assignments are locked/i.test(revokeError.message)
          ? "Há uma avaliação em andamento ou uma escala protegida. Conclua a operação antes de remover o acesso."
          : "Não foi possível remover o acesso. Verifique se a atualização do banco foi aplicada e se o juiz possui avaliações em andamento.");
        return;
      }
      setApplications((items) => items.map((item) => item.id === application.id ? { ...item, status: "rejected" } : item));
      setRevokeTarget(null);
    } catch { setError("Falha de conexão. Atualize a página e confira o acesso antes de tentar novamente."); }
    finally { setWorking(""); }
  }

  async function decide(application: Application, approved: boolean) {
    setError("");
    setWorking(application.id);
    const supabase = createClient();
    let { error: reviewError } = await supabase.rpc("review_judge_application", {
      target_application: application.id,
      approved,
    });

    // Compatibilidade para instalações que ainda não executaram a migration 014.
    if (reviewError?.code === "PGRST202") {
      if (approved) {
        const { error: roleError } = await supabase
          .from("user_roles")
          .upsert({ user_id: application.user_id, organization_id: organizationId, role: "judge" }, { onConflict: "user_id,organization_id,role" });
        reviewError = roleError;
      }
      if (!reviewError) {
        const { error: statusError } = await supabase
          .from("judge_applications")
          .update({ status: approved ? "approved" : "rejected", reviewed_at: new Date().toISOString() })
          .eq("id", application.id);
        reviewError = statusError;
      }
    }

    if (reviewError) {
      setError(reviewError.message);
      setWorking("");
      return;
    }

    setApplications((items) => items.map((item) => item.id === application.id ? {
      ...item,
      status: approved ? "approved" : "rejected",
    } : item));
    setWorking("");
  }

  const pending = applications.filter((item) => item.status === "pending");
  return (
    <section className="applications-workspace">
      {error && <div className="form-error">{error}</div>}
      <div className="applications-summary"><Clock3 /><span>{pending.length} solicitação(ões) aguardando análise</span></div>
      <div className="judge-list">
        {applications.length ? applications.map((application) => (
          <article key={application.id}>
            <span className="person-dot"><UserRound /></span>
            <div><strong>{application.full_name}</strong><span>{application.email} · solicitado em {new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(application.created_at))}</span></div>
            <b>{application.status === "pending" ? "Pendente" : application.status === "approved" ? "Liberado" : "Recusado"}</b>
            {application.status !== "approved" && <div className="application-actions">
              <button className="approve" disabled={!!working} onClick={() => void decide(application, true)}><Check />{application.status === "rejected" ? "Liberar novamente" : "Liberar"}</button>
              {application.status === "pending" && <button disabled={!!working} onClick={() => void decide(application, false)}><ShieldX />Recusar</button>}
            </div>}
            {application.status === "approved" && <button disabled={!!working} onClick={() => { setError(""); setRevokeTarget(application); }}><ShieldX />Remover acesso</button>}
          </article>
        )) : <div className="empty-state compact"><UserRound /><h2>Nenhuma solicitação</h2><p>Os juízes podem se cadastrar pela página pública de cadastro.</p></div>}
      </div>
      {revokeTarget && <div className="modal-wrap"><button className="backdrop" aria-label="Fechar" disabled={!!working} onClick={() => setRevokeTarget(null)} /><section className="modal" role="dialog" aria-modal="true" aria-labelledby="revoke-judge-title">
        <h2 id="revoke-judge-title">Remover acesso de {revokeTarget.full_name}?</h2>
        <p>O acesso como juiz será retirado desta organização e as designações futuras serão desativadas. Notas, votos e registros de eventos encerrados serão preservados. Outros papéis que a pessoa possuir não serão removidos.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button className="secondary" disabled={!!working} onClick={() => setRevokeTarget(null)}>Cancelar</button><button className="primary" disabled={!!working} onClick={() => void revoke(revokeTarget)}>{working ? "Removendo..." : "Remover acesso de juiz"}</button></div>
      </section></div>}
    </section>
  );
}
