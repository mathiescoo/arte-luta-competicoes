import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import JudgeApplications, { type JudgeEventOption } from "./judge-applications";

export const dynamic = "force-dynamic";

export default async function JudgesPage() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");

  const { data: role } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!role) redirect("/painel");

  const [{ data: applications }, { data: events }] = await Promise.all([
    supabase
      .from("judge_applications")
      .select("id,full_name,email,status,created_at,user_id")
      .eq("organization_id", role.organization_id)
      .order("created_at", { ascending: false }),
    supabase
      .from("events")
      .select("id,name,status,competitions(id,name,model,categories(id,name)),rings(id,name)")
      .eq("organization_id", role.organization_id)
      .not("status", "in", "(finished,archived)")
      .order("starts_at", { ascending: true, nullsFirst: false }),
  ]);

  return (
    <main className="management-page">
      <Link href="/painel" className="back-link">← Voltar para visão geral</Link>
      <div className="management-top">
        <div>
          <span className="eyebrow">EQUIPE</span>
          <h1>Juízes e acessos</h1>
          <p>Autorize cada juiz já direcionando-o para o evento, competição e categoria em que atuará.</p>
        </div>
      </div>
      <JudgeApplications
        organizationId={role.organization_id}
        initialApplications={applications || []}
        events={(events || []) as unknown as JudgeEventOption[]}
      />
    </main>
  );
}
