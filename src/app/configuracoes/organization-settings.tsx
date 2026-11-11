"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Save, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
type Organization = { id: string; name: string; slug: string };

export default function OrganizationSettings({ organization, canEdit }: { organization: Organization; canEdit: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(organization.name);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || loading) return;
    if (name.trim().length < 2) { setError("Informe um nome com pelo menos dois caracteres."); return; }
    setLoading(true); setMessage(""); setError("");
    try {
      const { data, error: saveError } = await createClient().from("organizations")
        .update({ name: name.trim() }).eq("id", organization.id).select("id,name").single();
      if (saveError || !data) { setError("Não foi possível salvar. Confira sua conexão e sua permissão de administrador."); return; }
      setName(data.name); setMessage("Configurações salvas."); router.refresh();
    } catch { setError("A conexão foi interrompida. Confira o nome salvo antes de tentar novamente."); }
    finally { setLoading(false); }
  }
  return <section className="settings-workspace"><form className="settings-card" onSubmit={save}>
    <span className="eyebrow">ORGANIZAÇÃO</span><h2>Identidade administrativa</h2>
    <label>Nome da organização<input value={name} required minLength={2} maxLength={150} disabled={!canEdit || loading} onChange={(event) => setName(event.target.value)} /></label>
    <label>Identificador interno<input value={organization.slug} disabled /></label>
    <small><ShieldCheck /> Somente administradores podem alterar estes dados.</small>
    {message && <div className="login-success" role="status">{message}</div>}{error && <div className="form-error" role="alert">{error}</div>}
    {canEdit && <button className="primary" type="submit" disabled={loading || name.trim().length < 2}><Save />{loading ? "Salvando..." : "Salvar alterações"}</button>}
  </form></section>;
}
