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
            {application.status === "pending" && <div className="application-actions">
              <button className="approve" disabled={working === application.id} onClick={() => void decide(application, true)}><Check />Liberar</button>
              <button disabled={working === application.id} onClick={() => void decide(application, false)}><ShieldX />Recusar</button>
            </div>}
          </article>
        )) : <div className="empty-state compact"><UserRound /><h2>Nenhuma solicitação</h2><p>Os juízes podem se cadastrar pela página pública de cadastro.</p></div>}
      </div>
    </section>
  );
}
