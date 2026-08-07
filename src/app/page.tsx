"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Award, CalendarDays, ChevronDown, CircleHelp, Clock3, Download, Eye, LayoutDashboard, Menu, MoreHorizontal, Play, Plus, Radio, Settings, Trophy, Users, X } from "lucide-react";

const rings = [
  { name: "Roda 1", status: "Aguardando votos", tone: "gold", category: "Adulto Avançado", blue: "Lucas Ferreira", green: "Rafael Costa", votes: 2, time: "00:18" },
  { name: "Roda 2", status: "Em andamento", tone: "green", category: "Mirim Iniciante", blue: "João Pedro", green: "Miguel Santos", votes: 0, time: "00:32" },
  { name: "Roda 3", status: "Preparando", tone: "blue", category: "Intermediário", blue: "Bruno Lima", green: "Caio Alves", votes: 0, time: "00:45" },
];

const events = [
  { day: "18", month: "OUT", title: "Campeonato e Festival Arte-Luta Brasil", meta: "Em andamento · São Paulo, SP", color: "#e5aa27" },
  { day: "02", month: "NOV", title: "Cante Comigo Capoeira Intérpretes", meta: "Inscrições abertas · Online", color: "#2f8c57" },
  { day: "14", month: "DEZ", title: "Festival Mirim de Capoeira", meta: "Rascunho · Guarulhos, SP", color: "#397bbb" },
];

export default function Home() {
  const [navOpen, setNavOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const [toast, setToast] = useState("");
  const [eventName, setEventName] = useState("");
  const [status, setStatus] = useState("Todos os eventos");
  const visibleEvents = useMemo(() => status === "Todos os eventos" ? events : events.filter((event) => event.meta.startsWith(status)), [status]);
  useEffect(() => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js"); }, []);

  function notify(message: string) { setToast(message); window.setTimeout(() => setToast(""), 2600); }
  function createEvent() {
    if (!eventName.trim()) return notify("Informe o nome do evento.");
    setModal(false); setEventName(""); notify("Rascunho criado. Continue pelo assistente de configuração.");
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <div className="brand"><div className="brand-mark">AL</div><div><strong>ARTE-LUTA</strong><span>BRASIL COMPETIÇÕES</span></div></div>
        <button className="mobile-close" aria-label="Fechar menu" onClick={() => setNavOpen(false)}><X /></button>
        <nav>
          <a className="active"><LayoutDashboard /> Visão geral</a>
          <a><CalendarDays /> Eventos</a>
          <a><Trophy /> Competições</a>
          <a><Users /> Participantes</a>
          <a><Award /> Resultados</a>
          <div className="nav-label">OPERAÇÃO</div>
          <a><Activity /> Controle das rodas</a>
          <a><Radio /> Telões ao vivo</a>
          <div className="nav-label">SISTEMA</div>
          <a><Settings /> Configurações</a>
          <a><CircleHelp /> Central de ajuda</a>
        </nav>
        <div className="profile"><div className="avatar">MM</div><div><strong>Matheus Mendes</strong><span>Administrador</span></div><MoreHorizontal /></div>
      </aside>
      {navOpen && <button className="backdrop" aria-label="Fechar menu" onClick={() => setNavOpen(false)} />}

      <main>
        <header><button className="menu-button" aria-label="Abrir menu" onClick={() => setNavOpen(true)}><Menu /></button><div><span className="eyebrow">QUINTA-FEIRA, 18 DE OUTUBRO</span><h1>Olá, Matheus.</h1></div><div className="header-actions"><button className="icon-button" aria-label="Ajuda"><CircleHelp /></button><button className="primary" onClick={() => setModal(true)}><Plus /> Novo evento</button></div></header>

        <section className="hero">
          <div><div className="live-pill"><i /> EVENTO EM ANDAMENTO</div><h2>Campeonato e Festival<br />Arte-Luta Brasil 2026</h2><p>Ginásio Municipal · São Paulo, SP</p><div className="hero-buttons"><button onClick={() => notify("Painel de operação aberto.")}><Play /> Abrir controle do evento</button><button className="ghost" onClick={() => notify("Prévia do telão preparada.")}><Eye /> Visualizar telão</button></div></div>
          <div className="hero-stat"><span>PROGRESSO GERAL</span><strong>7 <small>de 18 categorias</small></strong><div className="progress"><i /></div><p><Clock3 /> Previsão de término: 18h40</p></div>
        </section>

        <section className="section-head"><div><span className="eyebrow">OPERAÇÃO EM TEMPO REAL</span><h3>Rodas em atividade</h3></div><button className="text-button" onClick={() => notify("Exibindo o painel das três rodas.")}>Ver painel completo →</button></section>
        <section className="ring-grid">
          {rings.map((ring) => <article className="ring-card" key={ring.name}>
            <div className="ring-top"><span className={`status ${ring.tone}`}><i /> {ring.status}</span><strong>{ring.name}</strong></div>
            <div className="ring-meta"><span>{ring.category}</span><span>Semifinal</span></div>
            <div className="fighters"><div><i className="blue" /><strong>{ring.blue}</strong><span>Competidor azul</span></div><b>×</b><div className="right"><i className="green" /><strong>{ring.green}</strong><span>Competidor verde</span></div></div>
            <div className="ring-foot"><span><Clock3 /> {ring.time}</span><span>{ring.votes} de 3 votos recebidos</span></div>
          </article>)}
        </section>

        <section className="lower-grid">
          <div><div className="section-head compact"><div><span className="eyebrow">AGENDA</span><h3>Próximos eventos</h3></div><select value={status} onChange={(e) => setStatus(e.target.value)}><option>Todos os eventos</option><option>Em andamento</option><option>Inscrições abertas</option><option>Rascunho</option></select></div>
            <div className="event-list">{visibleEvents.map((event) => <button key={event.title} onClick={() => notify(`${event.title} selecionado.`)}><div className="date" style={{borderColor:event.color}}><strong>{event.day}</strong><span>{event.month}</span></div><div><strong>{event.title}</strong><span>{event.meta}</span></div><ChevronDown className="event-arrow" /></button>)}</div>
          </div>
          <aside className="quick"><span className="eyebrow">ATALHOS</span><h3>Ações rápidas</h3><button onClick={() => setModal(true)}><Plus /><div><strong>Criar novo evento</strong><span>Comece por um modelo pronto</span></div></button><button onClick={() => notify("Importador CSV aberto.")}><Download /><div><strong>Importar participantes</strong><span>Use CSV ou respostas de formulário</span></div></button><button onClick={() => notify("Sessão de telão pronta para configuração.")}><Radio /><div><strong>Abrir sessão de telão</strong><span>Gere um link ou código de acesso</span></div></button></aside>
        </section>
      </main>

      {modal && <div className="modal-wrap" role="dialog" aria-modal="true" aria-label="Criar novo evento"><button className="backdrop" aria-label="Fechar" onClick={() => setModal(false)} /><div className="modal"><button className="modal-x" aria-label="Fechar" onClick={() => setModal(false)}><X /></button><span className="eyebrow">ASSISTENTE DE CONFIGURAÇÃO</span><h2>Criar novo evento</h2><p>Escolha um nome agora. Competições, categorias, juízes e rodas serão configurados nas próximas etapas.</p><label>Nome do evento<input autoFocus value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="Ex.: Festival Arte-Luta 2027" /></label><label>Modelo<select><option>Campeonato Interno + Festival Mirim</option><option>Cante Comigo Capoeira Intérpretes</option><option>Evento em branco</option></select></label><div className="modal-actions"><button className="secondary" onClick={() => setModal(false)}>Cancelar</button><button className="primary" onClick={createEvent}>Criar rascunho</button></div></div></div>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
