import Link from "next/link";

export default function NotFound() {
  return <main className="management-page recovery-page"><span className="eyebrow">ARENA ARTE LUTA</span>
    <h1>Página não encontrada</h1><p>Confira o endereço. Para inscrições e telões, solicite à organização o link atualizado.</p>
    <Link className="primary" href="/painel">Ir para o painel</Link>
  </main>;
}
