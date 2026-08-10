import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PublicDisplay from "./public-display";
export const dynamic="force-dynamic";
export default async function PublicDisplayPage({params}:{params:Promise<{pin:string}>}){const {pin}=await params;if(!/^\d{6}$/.test(pin))notFound();const supabase=await createClient();const {data}=await supabase.rpc("display_board",{session_pin:pin}).maybeSingle();if(!data)notFound();return <PublicDisplay board={data as never} pin={pin}/>}
