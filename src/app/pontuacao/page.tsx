import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ScoringWorkspace from "./scoring-workspace";
import styles from "./scoring.module.css";
import responsiveStyles from "./scoring-responsive.module.css";

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
  const judgeOnly = canJudge && !canManage;
  const returnHref = judgeOnly ? "/avaliar" : "/painel";
  const returnLabel = judgeOnly ? "← Voltar para avaliações ao vivo" : "← Voltar para visão geral";

  if (!canManage && !canJudge) redirect("/painel");

  return (
    <main className={`${styles.page} ${responsiveStyles.page} brand-scoring-page`}>
      <Link href={returnHref} className={`${styles.backLink} ${responsiveStyles.backLink}`}>{returnLabel}</Link>
      <header className={`${styles.heading} ${responsiveStyles.heading}`}>
        <div>
          <span className={`eyebrow ${responsiveStyles.eyebrow}`}>{judgeOnly ? "PAINEL DO JUIZ" : "CANTE COMIGO E AVALIAÇÕES"}</span>
          <h1>{judgeOnly ? "Minha ficha de avaliação" : "Notas e apresentações"}</h1>
          <p>{judgeOnly ? "Quando uma apresentação for liberada para você, registre as notas nesta ficha de forma simples e segura." : "Configure os critérios, abra cada apresentação e registre as notas dos juízes com segurança."}</p>
        </div>
      </header>
      <ScoringWorkspace canManage={canManage} canJudge={canJudge} />
    </main>
  );
}
