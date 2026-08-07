"use client";
import { FormEvent, useState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
export default function LoginPage() {
  const router=useRouter();
  const [email,setEmail]=useState(""); const [password,setPassword]=useState(""); const [error,setError]=useState(""); const [loading,setLoading]=useState(false);
  async function signIn(event: FormEvent){ event.preventDefault(); setLoading(true); setError(""); const {error:authError}=await createClient().auth.signInWithPassword({email,password}); if(authError){setError("E-mail ou senha inválidos.");setLoading(false);return;} router.push("/painel"); router.refresh(); }
  return <main className="login-page"><section className="login-brand"><div className="brand-mark">AL</div><span>ARTE-LUTA BRASIL</span><h1>Competições que<br/>mantêm a roda viva.</h1><p>Gestão segura de eventos, avaliações e resultados em tempo real.</p></section><section className="login-panel"><form onSubmit={signIn}><div className="login-icon"><LockKeyhole/></div><span className="eyebrow">ACESSO RESTRITO</span><h2>Entre na plataforma</h2><p>Use a conta criada pela administração.</p><label>E-mail<input type="email" required autoComplete="email" value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="voce@exemplo.com"/></label><label>Senha<input type="password" required autoComplete="current-password" value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="Sua senha"/></label>{error&&<div className="login-error">{error}</div>}<button className="primary" disabled={loading}>{loading?"Entrando...":"Entrar"}<ArrowRight/></button><small>Problemas com o acesso? Fale com o administrador do evento.</small></form></section></main>;
}
