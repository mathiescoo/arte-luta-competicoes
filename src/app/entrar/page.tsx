"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function Login() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const params = useSearchParams();
  const switchAccount = params.get("trocar") === "1";
  const reason = params.get("erro");
  const message = error || (reason === "sem-acesso"
    ? "Sua conta entrou, mas ainda não possui permissão na organização. Peça a liberação a um administrador."
    : reason ? "O Google não concluiu o acesso. Tente novamente." : "");

  async function login() {
    setLoading(true);
    setError("");
    const { error: oauthError } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/complete?next=/painel`,
        queryParams: switchAccount ? { prompt: "select_account" } : undefined,
      },
    });
    if (oauthError) {
      setError(oauthError.message);
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="brand-mark">AL</div>
        <span>ARTE-LUTA BRASIL</span>
        <h1>Competições que<br />mantêm a roda viva.</h1>
        <p>Gestão segura de eventos, avaliações e resultados em tempo real.</p>
      </section>
      <section className="login-panel">
        <div>
          <div className="login-icon"><LockKeyhole /></div>
          <span className="eyebrow">ACESSO RESTRITO</span>
          <h2>{switchAccount ? "Escolha outra conta" : "Entre na plataforma"}</h2>
          <p>{switchAccount ? "Selecione a conta Google que deseja usar." : "Use sua conta Google autorizada pela organização."}</p>
          <button className="google-button" onClick={login} disabled={loading}>
            <span>G</span>{loading ? "Abrindo Google..." : "Continuar com Google"}<ArrowRight />
          </button>
          {message && <div className="login-error">{message}</div>}
          <Link className="judge-signup-link" href="/cadastro-juiz">Sou juiz e quero solicitar acesso</Link>
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><Login /></Suspense>;
}
