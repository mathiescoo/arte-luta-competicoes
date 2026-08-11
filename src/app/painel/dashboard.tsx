"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Activity,
  Award,
  CalendarDays,
  ChevronRight,
  CircleHelp,
  Clock3,
  Eye,
  Gavel,
  LayoutDashboard,
  LogOut,
  Menu,
  Music2,
  MoreHorizontal,
  Plus,
  Radio,
  Repeat2,
  Settings,
  Trophy,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Ring = { id: string; name: string; status: string };
type Event = {
  id: string;
  name: string;
  edition: string | null;
  city: string | null;
  venue: string | null;
  status: string;
  starts_at: string | null;
  created_at: string;
  competitions: Array<{ id: string; categories: Array<{ id: string }> }>;
  rings: Array<Ring>;
};

const statusName: Record<string, string> = {
  draft: "Rascunho",
  registration_open: "Inscrições abertas",
  registration_closed: "Inscrições encerradas",
  preparing: "Preparação",
  live: "Em andamento",
  finished: "Finalizado",
  archived: "Arquivado",
};

export default function Dashboard({ name, role, events }: { name: string; role: string; events: Event[] }) {
  const [navOpen, setNavOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [filter, setFilter] = useState("Todos");

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  }, []);

  const active = events.find((event) => event.status === "live") || events.find((event) => event.status !== "archived") || null;
  const filtered = useMemo(
    () => (filter === "Todos" ? events : events.filter((event) => statusName[event.status] === filter)),
    [filter, events],
  );
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();

  async function leaveAccount(selectAnotherAccount: boolean) {
    setProfileOpen(false);
    try {
      await createClient().auth.signOut({ scope: "local" });
    } finally {
      window.location.assign(selectAnotherAccount ? "/entrar?trocar=1" : "/entrar");
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <Link className="brand brand-logo-link" href="/painel" aria-label="Arena Arte Luta">
          <Image className="brand-logo-image" src="/brand/capoeira-arte-luta-brasil.png" alt="Logo Capoeira Arte-Luta Brasil" width={1536} height={1024} priority />
          <span className="brand-platform-name">ARENA ARTE LUTA</span>
        </Link>
        <button className="mobile-close" aria-label="Fechar menu" onClick={() => setNavOpen(false)}>
          <X />
        </button>

        <nav onClick={() => setNavOpen(false)}>
          <Link className="active" href="/painel"><LayoutDashboard />Visão geral</Link>
          <Link href="/eventos"><CalendarDays />Eventos</Link>
          <Link href="/eventos"><Trophy />Competições</Link>
          <Link href="/participantes"><Users />Participantes</Link>
          <Link href="/juizes"><Gavel />Liberação de juízes</Link>
          <Link href="/resultados"><Award />Resultados</Link>
          <div className="nav-label">OPERAÇÃO</div>
          <Link href="/rodas"><Activity />Controle das rodas</Link>
          <Link href="/pontuacao"><Music2 />Avaliações Cante Comigo</Link>
          <Link href="/telao"><Radio />Telões ao vivo</Link>
          <div className="nav-label">SISTEMA</div>
          <Link href="/usuarios"><UserCog />Usuários e acessos</Link>
          <Link href="/configuracoes"><Settings />Configurações</Link>
          <Link href="/ajuda"><CircleHelp />Central de ajuda</Link>
        </nav>

        <div className="profile">
          <div className="avatar">{initials}</div>
          <div className="profile-details">
            <strong>{name}</strong>
            <span>{role === "admin" ? "Administrador" : "Organizador"}</span>
          </div>
          <button
            className="profile-menu-trigger"
            aria-label="Abrir menu da conta"
            aria-expanded={profileOpen}
            onClick={() => setProfileOpen((open) => !open)}
          >
            <MoreHorizontal />
          </button>
          {profileOpen && (
            <div className="profile-menu" role="menu">
              <div className="profile-menu-identity">
                <strong>{name}</strong>
                <span>{role === "admin" ? "Administrador" : "Organizador"}</span>
              </div>
              {role === "admin" && <Link href="/usuarios" onClick={() => setProfileOpen(false)}><UserCog />Gerenciar usuários</Link>}
              <Link href="/configuracoes" onClick={() => setProfileOpen(false)}><Settings />Minha organização</Link>
              <button onClick={() => void leaveAccount(true)}><Repeat2 />Trocar conta</button>
              <button className="danger" onClick={() => void leaveAccount(false)}><LogOut />Sair da conta</button>
            </div>
          )}
        </div>
      </aside>

      {navOpen && <button className="backdrop" aria-label="Fechar menu" onClick={() => setNavOpen(false)} />}
      <main>
        <header>
          <button className="menu-button" aria-label="Abrir menu" onClick={() => setNavOpen(true)}><Menu /></button>
          <div>
            <span className="eyebrow">PAINEL ADMINISTRATIVO</span>
            <h1>Olá, {name.split(" ")[0]}.</h1>
          </div>
          <div className="header-actions">
            <Link className="icon-button" aria-label="Ajuda" href="/ajuda"><CircleHelp /></Link>
            <Link className="primary" href="/eventos/novo"><Plus />Novo evento</Link>
          </div>
        </header>

        {active ? (
          <section className="hero">
            <div>
              <div className="live-pill"><i /> {statusName[active.status]?.toUpperCase()}</div>
              <h2>{active.name}</h2>
              <p>{[active.venue, active.city].filter(Boolean).join(" · ") || "Local a definir"}</p>
              <div className="hero-buttons">
                <Link className="hero-primary" href="/rodas"><Activity />Abrir controle das rodas</Link>
                <Link className="ghost" href="/telao"><Eye />Visualizar telão</Link>
              </div>
            </div>
            <div className="hero-stat">
              <span>CONFIGURAÇÃO</span>
              <strong>{active.competitions.length}<small> competições</small></strong>
              <div className="progress"><i style={{ width: `${active.competitions.length ? 100 : 0}%` }} /></div>
              <p><Clock3 />{active.competitions.reduce((sum, item) => sum + item.categories.length, 0)} categorias cadastradas</p>
            </div>
          </section>
        ) : (
          <section className="hero empty-hero">
            <div>
              <div className="live-pill"><i /> SEM EVENTOS ATIVOS</div>
              <h2>Comece pelo seu<br />primeiro evento.</h2>
              <p>Crie um evento e selecione as competições.</p>
              <div className="hero-buttons"><Link className="hero-primary" href="/eventos/novo"><Plus />Criar evento</Link></div>
            </div>
          </section>
        )}

        <section className="section-head">
          <div><span className="eyebrow">OPERAÇÃO EM TEMPO REAL</span><h3>Rodas em atividade</h3></div>
          <Link className="text-button" href="/rodas">Gerenciar rodas →</Link>
        </section>
        {active?.rings.length ? (
          <section className="ring-grid">
            {active.rings.map((ring) => (
              <article className="ring-card" key={ring.id}>
                <div className="ring-top"><span className="status gold"><i /> {ring.status}</span><strong>{ring.name}</strong></div>
                <div className="empty-ring"><Activity /><span>Nenhum confronto iniciado</span><small>Configure juízes e categorias para esta roda.</small></div>
                <Link href="/rodas" className="ring-link">Abrir controle <ChevronRight /></Link>
              </article>
            ))}
          </section>
        ) : (
          <div className="empty-inline"><Activity /><span>{active ? "Este evento ainda não possui rodas configuradas." : "Crie um evento para configurar as rodas."}</span><Link href={active ? "/rodas" : "/eventos/novo"}>{active ? "Criar rodas" : "Criar evento"}</Link></div>
        )}

        <section className="lower-grid">
          <div>
            <div className="section-head compact">
              <div><span className="eyebrow">AGENDA</span><h3>Eventos cadastrados</h3></div>
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                <option>Todos</option><option>Rascunho</option><option>Inscrições abertas</option><option>Preparação</option><option>Em andamento</option><option>Finalizado</option>
              </select>
            </div>
            <div className="event-list">
              {filtered.length ? filtered.map((event) => {
                const date = event.starts_at ? new Date(event.starts_at) : null;
                return <Link href={`/eventos/${event.id}`} key={event.id}><div className="date"><strong>{date ? date.getUTCDate() : "—"}</strong><span>{date ? date.toLocaleString("pt-BR", { month: "short" }).replace(".", "").toUpperCase() : "DATA"}</span></div><div><strong>{event.name}</strong><span>{statusName[event.status] || event.status}{event.city ? ` · ${event.city}` : ""}</span></div><ChevronRight className="event-arrow" /></Link>;
              }) : <div className="list-empty">Nenhum evento corresponde a este filtro.</div>}
            </div>
          </div>
          <aside className="quick">
            <span className="eyebrow">ATALHOS</span><h3>Ações rápidas</h3>
            <Link href="/eventos/novo"><Plus /><div><strong>Criar novo evento</strong><span>Escolha uma ou mais competições</span></div></Link>
            <Link href="/participantes"><Users /><div><strong>Cadastrar participante</strong><span>Inscreva por categoria</span></div></Link>
            <Link href="/telao"><Radio /><div><strong>Abrir sessão de telão</strong><span>Crie uma sessão de exibição</span></div></Link>
          </aside>
        </section>
      </main>
    </div>
  );
}
