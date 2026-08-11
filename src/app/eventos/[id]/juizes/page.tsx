import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import JudgeManager from "./judge-manager";

export const dynamic = "force-dynamic";

function oneProfile(value: unknown): { id: string; full_name: string } | null {
  if (Array.isArray(value)) {
    const first = value[0] as { id: string; full_name: string } | undefined;
    return first ?? null;
  }
  return value as { id: string; full_name: string } | null;
}

export default async function JudgesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");

  const { data: roles } = await supabase.from("user_roles").select("organization_id,role").eq("user_id", userId);
  const managerRole = roles?.find((role) => role.role === "admin") || roles?.find((role) => role.role === "organizer");
  if (!managerRole) redirect(roles?.some((role) => role.role === "judge") ? "/avaliar" : "/painel");

  const [{ data: event }, { data: judgeRoles }, { data: assignments }] = await Promise.all([
    supabase.from("events").select("id,name,competitions(id,name,model,categories(id,name)),rings(id,name)").eq("id", id).eq("organization_id", managerRole.organization_id).maybeSingle(),
    supabase.from("user_roles").select("user_id,profiles(id,full_name)").eq("organization_id", managerRole.organization_id).eq("role", "judge"),
    supabase.from("judge_assignments").select("id,judge_id,competition_id,category_id,ring_id,active,profiles(full_name),competitions(name),categories(name),rings(name)").eq("event_id", id),
  ]);
  if (!event) notFound();

  const profiles = (judgeRoles || []).flatMap((membership) => {
    const profile = oneProfile(membership.profiles);
    return profile ? [{ id: membership.user_id, full_name: profile.full_name }] : [];
  });

  return <main className="management-page"><Link href={`/eventos/${id}`} className="back-link">← Voltar para configuração do evento</Link><div className="event-detail-head"><div><span className="eyebrow">{event.name}</span><h1>Juízes e designações</h1><p>Escolha apenas juízes aprovados e defina a competição, categoria e roda em que atuarão.</p></div></div><JudgeManager event={event} profiles={profiles} initialAssignments={assignments || []} /></main>;
}
