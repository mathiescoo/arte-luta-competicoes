"use client";

import { useMemo, useState } from "react";
import { Copy, MonitorPlay, Plus, Power } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Event = { id: string; name: string; rings: Array<{ id: string; name: string }> };
type Session = { id: string; name: string; event_id: string; ring_id: string | null; pin: string; active: boolean; created_at: string };

function randomPin() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return String(100000 + (value[0] % 900000));
}

export default function DisplayManager({ organizationId, initialEvents, initialSessions }: { organizationId: string; initialEvents: Event[]; initialSessions: Session[] }) {
  const [sessions, setSessions] = useState(initialSessions);
  const [eventId, setEventId] = useState(initialEvents[0]?.id || "");
  const [ringId, setRingId] = useState("");
  const [name, setName] = useState("Telão principal");
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const current = useMemo(() => initialEvents.find((item) => item.id === eventId), [eventId, initialEvents]);

  async function create() {
    if (!eventId || !name.trim()) return;
    setCreating(true);
    setMessage("");
    const supabase = createClient();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data, error } = await supabase.from("display_sessions").insert({ organization_id: organizationId, event_id: eventId, ring_id: ringId || null, name: name.trim(), pin: randomPin(), active: true }).select("id,name,event_id,ring_id,pin,active,created_at").single();
      if (!error && data) {
        setSessions((items) => [data as Session, ...items]);
        setMessage("Sessão criada. Use o link ou abra o telão.");
        setCreating(false);
        return;
      }
      if (error?.code !== "23505") {
        setMessage(error?.message || "Não foi possível criar a sessão.");
        setCreating(false);
        return;
      }
    }
    setMessage("Não foi possível reservar um PIN exclusivo. Tente novamente.");
    setCreating(false);
  }

  async function toggle(session: Session) {
    const { error } = await createClient().from("display_sessions").update({ active: !session.active }).eq("id", session.id);
    if (error) {
      setMessage(error.message);
      return;
    }
    setSessions((items) => items.map((item) => item.id === session.id ? { ...item, active: !item.active } : item));
  }

  return <section className="operations-workspace"><div className="display-form"><label>Evento<select value={eventId} onChange={(eventChange) => { setEventId(eventChange.target.value); setRingId(""); }}>{initialEvents.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}</select></label><label>Roda<select value={ringId} onChange={(eventChange) => setRingId(eventChange.target.value)}><option value="">Telão geral · Cante Comigo</option>{current?.rings.map((ring) => <option key={ring.id} value={ring.id}>{ring.name}</option>)}</select></label><label>Nome<input value={name} onChange={(eventChange) => setName(eventChange.target.value)} /></label><button className="primary" onClick={create} disabled={!eventId || creating}><Plus />{creating ? "Criando..." : "Criar sessão"}</button></div><p className="display-helper">Use o <b>telão geral</b> para musicalidade: ele mostra automaticamente a apresentação aberta, categoria, música e autor. Telões por roda são apenas para confrontos.</p>{message && <div className="login-success">{message}</div>}<div className="display-list">{sessions.length ? sessions.map((session) => <article key={session.id}><MonitorPlay /><div><strong>{session.name} {!session.active && "· pausado"}</strong><span>PIN: <b>{session.pin}</b></span></div><a href={`/telao/${session.pin}`} target="_blank" rel="noreferrer">Abrir</a><button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/telao/${session.pin}`)} title="Copiar link do telão"><Copy /></button><button onClick={() => toggle(session)} title={session.active ? "Pausar sessão" : "Ativar sessão"}><Power /></button></article>) : <div className="empty-state compact"><MonitorPlay /><h2>Nenhum telão criado</h2><p>Crie uma sessão para gerar um acesso público.</p></div>}</div></section>;
}
