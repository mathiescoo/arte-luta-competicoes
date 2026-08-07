"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function CompleteAuthPage() {
  const [message, setMessage] = useState("Confirmando seu acesso com Google...");

  useEffect(() => {
    async function complete() {
      const supabase = createClient();
      const existing = await supabase.auth.getSession();
      if (existing.data.session) {
        window.location.replace("/painel");
        return;
      }
      const code = new URLSearchParams(window.location.search).get("code");
      if (!code) {
        setMessage("Não recebemos a confirmação do Google. Volte e tente novamente.");
        return;
      }
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        setMessage(`Não foi possível concluir o acesso: ${error.message}`);
        return;
      }
      window.location.replace("/painel");
    }
    complete();
  }, []);

  return <main className="login-page"><section className="login-brand"><div className="brand-mark">AL</div><span>ARTE-LUTA BRASIL</span><h1>Conectando<br/>sua conta.</h1></section><section className="login-panel"><div className="auth-loading"><div className="login-icon">AL</div><h2>{message}</h2><p>Não feche esta página.</p></div></section></main>;
}
