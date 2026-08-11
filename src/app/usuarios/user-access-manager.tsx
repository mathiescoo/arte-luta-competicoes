"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldCheck, UserCog, UsersRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export type UserRole = "admin" | "organizer" | "judge" | "display";
export type ManagedUser = {
  id: string;
  name: string;
  email: string;
  phone: string;
  roles: UserRole[];
};

const roleLabels: Record<UserRole, { label: string; description: string }> = {
  admin: { label: "Administrador", description: "Controle completo da organização" },
  organizer: { label: "Organizador", description: "Gerencia eventos e inscrições" },
  judge: { label: "Juiz", description: "Avalia disputas designadas" },
  display: { label: "Telão", description: "Acesso a exibições do evento" },
};
const roles = Object.keys(roleLabels) as UserRole[];

export default function UserAccessManager({ organizationId, currentUserId, initialUsers }: { organizationId: string; currentUserId: string; initialUsers: ManagedUser[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [working, setWorking] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const adminCount = useMemo(() => users.filter((user) => user.roles.includes("admin")).length, [users]);

  async function updateAccess(user: ManagedUser, role: UserRole, enabled: boolean) {
    const actionId = `${user.id}-${role}`;
    if (!enabled && role === "admin" && (user.id === currentUserId || adminCount <= 1)) {
      setError("Mantenha pelo menos um administrador e não remova seu próprio acesso administrativo.");
      return;
    }

    setWorking(actionId);
    setMessage("");
    setError("");
    const supabase = createClient();
    let { error: actionError } = await supabase.rpc("manage_organization_access", {
      target_user: user.id,
      target_organization: organizationId,
      target_role: role,
      enabled,
    });

    // Compatibilidade com instalações anteriores à migration 014.
    if (actionError?.code === "PGRST202") {
      const fallback = enabled
        ? await supabase.from("user_roles").upsert({ user_id: user.id, organization_id: organizationId, role }, { onConflict: "user_id,organization_id,role" })
        : await supabase.from("user_roles").delete().eq("user_id", user.id).eq("organization_id", organizationId).eq("role", role);
      actionError = fallback.error;
    }

    if (actionError) {
      setError(actionError.message);
      setWorking("");
      return;
    }

    setUsers((current) => current.map((item) => item.id !== user.id ? item : {
      ...item,
      roles: enabled ? [...item.roles, role] : item.roles.filter((itemRole) => itemRole !== role),
    }));
    setMessage(`${roleLabels[role].label} ${enabled ? "liberado" : "removido"} para ${user.name}.`);
    setWorking("");
  }

  return (
    <section className="users-workspace">
      <div className="users-intro">
        <UsersRound />
        <div><strong>{users.length} pessoa(s) com acesso</strong><span>As credenciais são da conta Google de cada usuário.</span></div>
      </div>
      <div className="users-note"><ShieldCheck /><span>Para novos juízes, use <b>Liberação de juízes</b>. Aqui você administra os acessos de quem já faz parte da organização.</span></div>
      {message && <div className="login-success"><CheckCircle2 />{message}</div>}
      {error && <div className="form-error"><AlertTriangle />{error}</div>}

      <div className="users-list">
        {users.map((user) => {
          const initials = user.name
            .split(" ")
            .slice(0, 2)
            .map((part) => part[0])
            .join("")
            .toUpperCase();
          const email = user.email || "E-mail não compartilhado por esta conta";

          return (
            <article className="user-access-card" key={user.id}>
              <div className="user-access-heading">
                <span className="user-avatar" aria-hidden="true">{initials}</span>
                <div className="user-access-identity">
                  <strong className="user-access-name">{user.name}{user.id === currentUserId && " (você)"}</strong>
                  <span className="user-access-email" title={email}>{email}</span>
                  {user.phone && <small className="user-access-phone">{user.phone}</small>}
                </div>
              </div>
              <div className="role-toggles">
                {roles.map((role) => {
                  const enabled = user.roles.includes(role);
                  const disabled = working.length > 0 || (!enabled && false) || (enabled && role === "admin" && (user.id === currentUserId || adminCount <= 1));
                  return (
                    <label className={`role-toggle ${enabled ? "enabled" : ""}`} key={role}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={disabled}
                        onChange={(event) => void updateAccess(user, role, event.target.checked)}
                      />
                      <span><b>{roleLabels[role].label}</b><small>{roleLabels[role].description}</small></span>
                    </label>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
      {!users.length && <div className="empty-state compact"><UserCog /><h2>Nenhum usuário vinculado</h2><p>Quando alguém for liberado como juiz ou organizador, aparecerá aqui.</p></div>}
    </section>
  );
}
