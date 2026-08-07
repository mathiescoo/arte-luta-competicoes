import Link from "next/link";
import { CalendarDays, ChevronRight, Plus } from "lucide-react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const statusName: Record<string,string>={draft:"Rascunho",registration_open:"Inscrições abertas",registration_closed:"Inscrições encerradas",preparing:"Preparação",live:"Em andamento",finished:"Finalizado",archived:"Arquivado"};

export default async function EventosPage(){
  const supabase=await createClient(); const {data:claims}=await supabase.auth.getClaims(); if(!claims?.claims?.sub) redirect("/entrar");
  const {data:events}=await supabase.from("events").select("id,name,edition,starts_at,city,status,competitions(name)").order("starts_at",{ascending:false});
  return <main className="management-page"><div className="management-top"><div><span className="eyebrow">GESTÃO</span><h1>Eventos</h1><p>Crie edições separadas ou reúna várias competições no mesmo dia.</p></div><Link className="primary" href="/eventos/novo"><Plus/>Novo evento</Link></div><div className="management-list">{events?.length?events.map((event)=><Link href={`/eventos/${event.id}`} className="management-row" key={event.id}><div className="row-icon"><CalendarDays/></div><div><strong>{event.name}{event.edition?` · ${event.edition}`:""}</strong><span>{event.starts_at?new Intl.DateTimeFormat("pt-BR",{dateStyle:"long",timeZone:"UTC"}).format(new Date(event.starts_at)):"Data a definir"}{event.city?` · ${event.city}`:""}</span><small>{event.competitions?.map((item:{name:string})=>item.name).join(" + ")||"Sem competições configuradas"}</small></div><b>{statusName[event.status]||event.status}</b><ChevronRight/></Link>):<div className="empty-state"><CalendarDays/><h2>Nenhum evento cadastrado</h2><p>Crie o primeiro evento e selecione as competições que acontecerão nele.</p><Link className="primary" href="/eventos/novo"><Plus/>Criar evento</Link></div>}</div><Link className="back-link" href="/painel">← Voltar para visão geral</Link></main>;
}
