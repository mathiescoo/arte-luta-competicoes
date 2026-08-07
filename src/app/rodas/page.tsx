import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import RingManager from "./ring-manager";
export const dynamic="force-dynamic";
export default async function RingsPage(){const supabase=await createClient();const {data:claims}=await supabase.auth.getClaims();if(!claims?.claims?.sub)redirect("/entrar");const {data:role}=await supabase.from("user_roles").select("organization_id").eq("user_id",claims.claims.sub).limit(1).maybeSingle();if(!role)redirect("/painel");const {data:events}=await supabase.from("events").select("id,name,status,rings(id,name,status,settings)").eq("organization_id",role.organization_id).neq("status","archived").order("created_at",{ascending:false});return <main className="management-page"><Link href="/painel" className="back-link">← Voltar para visão geral</Link><div className="management-top"><div><span className="eyebrow">OPERAÇÃO</span><h1>Controle das rodas</h1><p>Crie rodas independentes e prepare a operação de cada competição.</p></div></div><RingManager initialEvents={events||[]}/></main>}
