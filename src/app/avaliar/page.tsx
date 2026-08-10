import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import JudgeVoting from "./judge-voting";
export const dynamic = "force-dynamic";
export default async function EvaluatePage(){const supabase=await createClient();const {data:claims}=await supabase.auth.getClaims();const userId=claims?.claims?.sub;if(!userId)redirect("/entrar");const {data:role}=await supabase.from("user_roles").select("role").eq("user_id",userId).eq("role","judge").maybeSingle();if(!role)redirect("/painel");const {data:matches,error}=await supabase.rpc("judge_live_matches");return <JudgeVoting initialMatches={(matches||[]) as never[]} loadError={error?.message||""}/>}
