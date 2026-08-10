"use client";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
export default function CompleteAuthPage(){useEffect(()=>{let done=false;const destination=new URL(window.location.href).searchParams.get("next")||"/painel";const finish=()=>{if(done)return;done=true;window.location.replace(destination.startsWith("/")?destination:"/painel")};const supabase=createClient();const {data:listener}=supabase.auth.onAuthStateChange((_event,session)=>{if(session)finish()});supabase.auth.getSession().then(({data})=>{if(data.session)finish()});const timer=window.setTimeout(()=>{if(!done)window.location.replace("/entrar?erro=oauth")},5000);return()=>{listener.subscription.unsubscribe();window.clearTimeout(timer)}},[]);return null}
