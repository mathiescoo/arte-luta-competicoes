import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import JudgeApplications from "./judge-applications";
export const dynamic="force-dynamic";
export default async function JudgesPage(){const supabase=await createClient();const {data:claims}=await supabase.auth.getClaims();if(!claims?.claims?.sub)redirect("/entrar");const {data:role}=await supabase.from("user_roles").select("organization_id,role").eq("user_id",claims.claims.sub).eq("role","admin").maybeSingle();if(!role)redirect("/painel");const {data:applications}=await supabase.from("judge_applications").select("id,full_name,email,status,created_at,user_id").eq("organization_id",role.organization_id).order("created_at",{ascending:false});return <main className="management-page"><Link href="/painel" className="back-link">← Voltar para visão geral</Link><div className="management-top"><div><span className="eyebrow">EQUIPE</span><h1>Liberação de juízes</h1><p>Analise solicitações e libere apenas quem poderá atuar nos eventos.</p></div></div><JudgeApplications organizationId={role.organization_id} initialApplications={applications||[]}/></main>}
