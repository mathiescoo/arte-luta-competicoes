"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
export default function RequestJudge(){const [error,setError]=useState("");const [done,setDone]=useState(false);useEffect(()=>{createClient().rpc("request_judge_access").then(({error})=>{if(error)setError(error.message);else setDone(true)})},[]);return <main className="login-page"><section className="login-brand"><div className="brand-mark">AL</div><span>ARTE-LUTA BRASIL</span><h1>Solicitação de<br/>juiz.</h1></section><section className="login-panel"><div className="login-icon"><ClipboardCheck/></div><span className="eyebrow">ACESSO DO JUIZ</span><h2>{done?"Solicitação enviada":"Concluindo cadastro"}</h2><p>{done?"Aguarde a liberação da organização. Depois, entre sempre com Google.":"Estamos registrando sua solicitação."}</p>{error&&<div className="login-error">{error}</div>}<Link className="primary" href="/entrar">Voltar ao login</Link></section></main>}
