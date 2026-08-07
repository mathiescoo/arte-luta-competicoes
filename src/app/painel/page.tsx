import { redirect } from "next/navigation";
import AdminDashboard from "../page";
import { createClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
export default async function PainelPage(){ const supabase=await createClient(); const {data}=await supabase.auth.getClaims(); if(!data?.claims?.sub) redirect("/entrar"); return <AdminDashboard/>; }
