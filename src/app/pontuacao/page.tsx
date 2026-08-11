import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ScoringWorkspace from "./scoring-workspace";
import styles from "./scoring.module.css";

export const dynamic = "force-dynamic";

export default async function ScoringPage() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;

  if (!userId) redirect("/entrar");

  const { data: roles } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);

  const roleNames = new Set((roles || []).map((item) => item.role));
  const canManage = roleNames.has("admin") || roleNames.has("organizer");
  const canJudge = roleNames.has("judge");

  if (!canManage && !canJudge) redirect("/painel");

  return (
    <main className={styles.page}>
      <Link href="/painel" className={styles.backLink}>← Voltar para visão geral</Link>
      <header className={styles.heading}>
        <div>
          <span className="eyebrow">CANTE COMIGO E AVALIAÇÕES</span>
          <h1>Notas e apresentações</h1>
          <p>Configure os critérios, abra cada apresentação e registre as notas dos juízes com segurança.</p>
        </div>
      </header>
      <ScoringWorkspace canManage={canManage} canJudge={canJudge} />
    </main>
  );
}
