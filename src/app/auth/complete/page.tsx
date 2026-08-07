"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function CompleteAuthPage() {
  const [message, setMessage] = useState("Confirmando seu acesso com Google...");

  useEffect(() => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.location.replace("/painel");
    };
    async function checkSession() {
      const supabase = createClient();
      const existing = await supabase.auth.getSession();
      if (existing.data.session) finish();
    }
    const supabase = createClient();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) finish();
    });
    checkSession();
    const interval = window.setInterval(checkSession, 300);
    const timeout = window.setTimeout(() => {
      if (!finished) setMessage("Ainda estamos aguardando a confirmação do Google. Aguarde mais alguns segundos.");
    }, 8000);
    return () => {
      listener.subscription.unsubscribe();
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, []);

  return <main className="login-page"><section className="login-brand"><div className="brand-mark">AL</div><span>ARTE-LUTA BRASIL</span><h1>Conectando<br/>sua conta.</h1></section><section className="login-panel"><div className="auth-loading"><div className="login-icon">AL</div><h2>{message}</h2><p>Não feche esta página.</p></div></section></main>;
}
