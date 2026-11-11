import { redirect } from "next/navigation";
import Link from "next/link";
import { BookOpen, CalendarDays, Gavel, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import OrganizationSettings from "./organization-settings";
export const dynamic="force-dynamic";
export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");
  const { data: roles, error: roleError } = await supabase.from("user_roles").select("organization_id,role").eq("user_id", userId);
  if (roleError) throw new Error("Não foi possível consultar as permissões.");
  const role = roles?.find((item) => item.role === "admin") || roles?.find((item) => item.role === "organizer");
  if (!role) redirect("/painel");
  const { data: organization, error } = await supabase.from("organizations").select("id,name,slug").eq("id", role.organization_id).maybeSingle();
  if (error) throw new Error("Não foi possível carregar a organização.");
  return <main className="management-page"><Link className="back-link" href="/painel">← Voltar para visão geral</Link>
    <div className="management-top"><div><span className="eyebrow">SISTEMA</span><h1>Configurações</h1><p>Gerencie a organização e encontre os controles de cada etapa do campeonato.</p></div></div>
    {organization ? <OrganizationSettings organization={organization} canEdit={role.role === "admin"} /> : <div className="empty-state compact"><h2>Organização não encontrada</h2></div>}
    <nav className="settings-navigation" aria-label="Configurações administrativas">
      {role.role === "admin" && <><Link href="/usuarios"><Users />Usuários e permissões de acesso</Link><Link href="/juizes"><Gavel />Solicitações e liberação de juízes</Link></>}
      <Link href="/eventos"><CalendarDays />Eventos: inscrições, pagamento opcional e relatório final</Link>
      <Link href="/ajuda"><BookOpen />Roteiro de preparação e operação</Link>
    </nav>
  </main>;
}
