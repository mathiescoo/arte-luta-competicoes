import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import UserAccessManager, { type ManagedUser, type UserRole } from "./user-access-manager";

export const dynamic = "force-dynamic";

function profileFrom(value: unknown): { full_name?: string; phone?: string | null } | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value as { full_name?: string; phone?: string | null } | null;
}

export default async function UsersPage() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");

  const { data: adminRole } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!adminRole) redirect("/painel");

  const [{ data: memberships }, { data: applications }] = await Promise.all([
    supabase
      .from("user_roles")
      .select("user_id,role,profiles(full_name,phone)")
      .eq("organization_id", adminRole.organization_id),
    supabase
      .from("judge_applications")
      .select("user_id,email,full_name,status")
      .eq("organization_id", adminRole.organization_id),
  ]);

  const applicationsByUser = new Map((applications ?? []).map((application) => [application.user_id, application]));
  const users = new Map<string, ManagedUser>();
  for (const membership of memberships ?? []) {
    const profile = profileFrom(membership.profiles);
    const application = applicationsByUser.get(membership.user_id);
    const existing = users.get(membership.user_id);
    const role = membership.role as UserRole;
    if (existing) {
      existing.roles.push(role);
      continue;
    }
    users.set(membership.user_id, {
      id: membership.user_id,
      name: profile?.full_name || application?.full_name || "Usuário sem nome",
      email: application?.email || (membership.user_id === userId ? String(claims.claims.email ?? "") : ""),
      phone: profile?.phone || "",
      roles: [role],
    });
  }

  return (
    <main className="management-page">
      <Link href="/painel" className="back-link">← Voltar para visão geral</Link>
      <div className="management-top">
        <div>
          <span className="eyebrow">ADMINISTRAÇÃO</span>
          <h1>Usuários e acessos</h1>
          <p>Defina o que cada pessoa pode fazer dentro da organização.</p>
        </div>
      </div>
      <UserAccessManager
        organizationId={adminRole.organization_id}
        currentUserId={userId}
        initialUsers={[...users.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))}
      />
    </main>
  );
}
