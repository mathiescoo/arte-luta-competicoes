"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Field = { key: string; label: string; type: "text" | "number" | "date" | "select"; required: boolean; options?: string[] };
type Config = { token: string | null; enabled: boolean; fields: Field[] };

export default function RegistrationFormManager({ eventId, closed = false }: { eventId: string; closed?: boolean }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve(createClient().rpc("manage_public_registration_form", { target_event: eventId })).then(({ data, error: loadError }) => {
      if (!active) return;
      if (loadError) setError(loadError.message);
      else setConfig(data as Config);
    }).catch(() => { if (active) setError("A conexão foi interrompida. Atualize a página para carregar o formulário."); });
    return () => { active = false; };
  }, [eventId]);
  function updateField(index: number, patch: Partial<Field>) {
    setConfig((current) => current && { ...current, fields: current.fields.map((field, i) => i === index ? { ...field, ...patch } : field) });
  }
  async function save() {
    if (!config || busy || closed) return;
    if (config.fields.some((field) => !field.label.trim() || (field.type === "select" && !field.options?.some((option) => option.trim())))) {
      setError("Preencha o nome e as opções dos campos configurados."); return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
    const { data, error: saveError } = await createClient().rpc("save_public_registration_form", {
      target_event: eventId, is_enabled: config.enabled, custom_fields: config.fields.map((field) => ({ ...field, ...(field.type === "select" ? { options: [...new Set((field.options || []).map((option) => option.trim()).filter(Boolean))] } : {}) })),
    });
    if (saveError || !data?.token) setError("Não foi possível salvar. Confira os campos, a conexão e suas permissões.");
    else { setConfig({ ...config, token: data.token }); setNotice("Formulário salvo. Para receber inscrições, o status do evento também deve estar em Inscrições abertas."); }
    } catch { setError("A conexão foi interrompida. Atualize e confira o formulário salvo antes de tentar novamente."); }
    finally { setBusy(false); }
  }
  async function copyLink() {
    if (!config?.token) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/inscricao/${config.token}`);
      setNotice("Link copiado. Você já pode compartilhá-lo com os participantes."); setError("");
    } catch { setError("O navegador não permitiu copiar. Abra o formulário e copie o endereço na barra do navegador."); }
  }
  if (!config) return error ? <p role="alert">Não foi possível carregar o formulário: {error}</p> : <p>Carregando formulário...</p>;
  return <section className="category-workspace">
    <div className="category-toolbar"><div><span className="eyebrow">INSCRIÇÕES PÚBLICAS</span><h2>Formulário do evento</h2><p>Nome, idade e categoria são solicitados para todos; música e autor são solicitados para musicalidade.</p></div></div>
    {closed && <p className="event-closed-notice">Evento encerrado: inscrições fechadas e formulário disponível apenas para consulta.</p>}
    <fieldset className="registration-form-fields" disabled={busy || closed} aria-label="Campos do formulário">
    <label className="toggle-setting"><input type="checkbox" checked={config.enabled} onChange={(event) => setConfig({ ...config, enabled: event.target.checked })} /><span>Ativar link de inscrição</span></label>
    {config.fields.map((field, index) => <div className="form-grid" key={field.key}>
      <label>Nome do campo<input value={field.label} maxLength={100} onChange={(event) => updateField(index, { label: event.target.value })} /></label>
      <label>Tipo<select value={field.type} onChange={(event) => updateField(index, { type: event.target.value as Field["type"], options: [] })}><option value="text">Texto</option><option value="number">Número</option><option value="date">Data</option><option value="select">Lista de opções</option></select></label>
      {field.type === "select" && <label className="wide">Uma opção por linha<textarea value={(field.options || []).join("\n")} onChange={(event) => updateField(index, { options: event.target.value.split("\n") })} /></label>}
      <label><span><input type="checkbox" checked={field.required} onChange={(event) => updateField(index, { required: event.target.checked })} /> Obrigatório</span></label>
      <button className="secondary" type="button" onClick={() => setConfig({ ...config, fields: config.fields.filter((_, i) => i !== index) })}>Remover campo</button>
    </div>)}
    <div className="modal-actions"><button className="secondary" type="button" disabled={config.fields.length >= 20} onClick={() => setConfig({ ...config, fields: [...config.fields, { key: `field_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, label: "", type: "text", required: false }] })}>Adicionar campo</button><button className="primary" type="button" onClick={() => void save()} disabled={busy}>{busy ? "Salvando..." : "Salvar formulário"}</button></div>
    </fieldset>
    {config.token && !closed && <p>Link: <a href={`/inscricao/${config.token}`} target="_blank" rel="noreferrer">Abrir formulário</a> <button className="secondary" type="button" onClick={() => void copyLink()}>Copiar link</button></p>}
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}
  </section>;
}
