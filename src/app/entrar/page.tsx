"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [recovery, setRecovery] = useState(false);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setLoading(true); setError(""); setMessage("");
    const { error: authError } = await createClient().auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (authError) {
      const detail = `${authError.code || ""} ${authError.message}`.toLowerCase();
      setError(detail.includes("banned") ? "Esta conta está temporariamente bloqueada no Supabase." : detail.includes("rate") || authError.status === 429 ? "Muitas tentativas foram realizadas. Aguarde alguns minutos." : detail.includes("confirm") ? "Seu e-mail ainda não foi confirmado." : "E-mail ou senha recusados pelo Supabase. Confira a senha ou redefina-a.");
      setLoading(false);
      return;
    }
    router.push("/painel"); router.refresh();
  }

  async function recover() {
    if (!email.trim()) { setError("Informe seu e-mail antes de solicitar a recuperação."); return; }
    setLoading(true); setError("");
    const { error: resetError } = await createClient().auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${window.location.origin}/redefinir-senha` });
    if (resetError) setError(resetError.status === 429 ? "O limite temporário de e-mails foi atingido. Aguarde e tente novamente." : `Falha ao enviar recuperação: ${resetError.message}`);
    else { setRecovery(true); setMessage("Enviamos um link de recuperação. Verifique também a caixa de spam."); }
    setLoading(false);
  }

  async function signInGoogle() {
    setLoading(true); setError("");
    const { error: oauthError } = await createClient().auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/auth/complete?next=/painel` } });
    if (oauthError) { setError(`Não foi possível abrir o Google: ${oauthError.message}`); setLoading(false); }
  }

  return <main className="login-page"><section className="login-brand"><div className="brand-mark">AL</div><span>ARTE-LUTA BRASIL</span><h1>Competições que<br />mantêm a roda viva.</h1><p>Gestão segura de eventos, avaliações e resultados em tempo real.</p></section><section className="login-panel"><form onSubmit={signIn}><div className="login-icon"><LockKeyhole /></div><span className="eyebrow">ACESSO RESTRITO</span><h2>{recovery ? "Verifique seu e-mail" : "Entre na plataforma"}</h2><p>{recovery ? "Use o link recebido para definir uma senha nova." : "Entre com Google ou use sua conta administrativa."}</p>{!recovery && <><button type="button" className="google-button" onClick={signInGoogle} disabled={loading}><span>G</span>Continuar com Google</button><div className="login-divider"><i />ou<i /></div></>}<label>E-mail<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@exemplo.com" /></label>{!recovery && <label>Senha<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha" /></label>}{error && <div className="login-error">{error}</div>}{message && <div className="login-success">{message}</div>}{!recovery && <button className="primary" disabled={loading}>{loading ? "Entrando..." : "Entrar"}<ArrowRight /></button>}<button type="button" className="forgot-button" onClick={recover} disabled={loading}>{recovery ? "Enviar o link novamente" : "Esqueci minha senha"}</button>{recovery && <button type="button" className="forgot-button" onClick={() => { setRecovery(false); setMessage(""); }}>Voltar ao login</button>}{!recovery && <Link className="judge-signup-link" href="/cadastro-juiz">Sou juiz e quero solicitar cadastro</Link>}</form></section></main>;
}
