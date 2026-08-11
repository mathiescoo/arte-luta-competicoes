"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="login-page">
      <section className="login-brand">
        <Image className="login-brand-logo" src="/brand/capoeira-arte-luta-brasil.png" alt="Logo Capoeira Arte-Luta Brasil" width={1536} height={1024} priority />
        <span>ARENA ARTE LUTA</span>
        <h1>Conectando sua conta.</h1>
        <p>Estamos validando o acesso seguro com a plataforma.</p>
      </section>
      <section className="login-panel"><div className="login-content">{children}</div></section>
    </main>
  );
}

export default function CompleteAuthPage() {
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function complete() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const next = url.searchParams.get("next") || "/painel";
      if (!code) {
        if (active) setError("O Google não retornou um código de acesso.");
        return;
      }

      const { error: exchangeError } = await createClient().auth.exchangeCodeForSession(code);
      if (exchangeError) {
        if (active) setError(exchangeError.message);
        return;
      }

      window.location.replace(next.startsWith("/") ? next : "/painel");
    }

    void complete();
    return () => { active = false; };
  }, []);

  if (!error) {
    return <AuthShell><div className="login-icon"><LoaderCircle /></div><span className="eyebrow">ACESSO SEGURO</span><h2>Conectando</h2><p>Não feche esta página. Isso normalmente leva apenas alguns segundos.</p></AuthShell>;
  }

  return (
    <AuthShell>
      <div className="login-icon"><LoaderCircle /></div>
      <span className="eyebrow">NÃO FOI POSSÍVEL CONCLUIR</span>
      <h2>Revise o acesso</h2>
      <div className="login-error"><strong>Detalhe do retorno:</strong><br />{error}</div>
      <p>Volte ao login e tente novamente. Se o problema continuar, envie esta mensagem ao suporte.</p>
      <Link className="primary" href="/entrar">Voltar ao login</Link>
    </AuthShell>
  );
}
