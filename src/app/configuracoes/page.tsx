import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import OrganizationSettings from "./organization-settings";
export const dynamic="force-dynamic";
export default async function SettingsPage(){const supabase=await createClient();const {data:claims}=await supabase.auth.getClaims();const userId=claims?.claims?.sub;if(!userId)redirect("/entrar");const {data:role}=await supabase.from("user_roles").select("organization_id,role").eq("user_id",userId).limit(1).maybeSingle();if(!role)redirect("/painel");const {data:organization}=await supabase.from("organizations").select("id,name,slug,settings").eq("id",role.organization_id).maybeSingle();return <main className="management-page"><Link className="back-link" href="/painel">← Voltar para visão geral</Link><div className="management-top"><div><span className="eyebrow">SISTEMA</span><h1>Configurações</h1><p>Defina a identidade básica usada nos seus campeonatos.</p></div></div>{organization?<OrganizationSettings organization={organization} canEdit={role.role==="admin"}/>:<div className="empty-state compact"><h2>Organização não encontrada</h2></div>}</main>}
