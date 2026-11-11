"use client";

import Link from "next/link";

export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return <main className="management-page recovery-page">
    <span className="eyebrow">ARENA ARTE LUTA</span>
    <h1>Não foi possível carregar esta tela</h1>
    <p>Confira a conexão e tente novamente. Se você estava salvando dados, verifique o resultado antes de repetir a operação.</p>
    <div className="recovery-actions"><button className="primary" onClick={() => retry()}>Tentar novamente</button><Link className="secondary" href="/painel">Voltar ao painel</Link></div>
  </main>;
}
