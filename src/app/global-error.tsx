"use client";

export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return <html lang="pt-BR"><body style={{ margin: 0, background: "#f4f6f2", color: "#17251b", fontFamily: "Arial, sans-serif" }}>
    <main style={{ maxWidth: 640, padding: "48px 24px", margin: "auto" }}>
      <h1>Vamos recuperar o acesso</h1><p>Não foi possível carregar o aplicativo. Confira a internet e tente novamente.</p>
      <p>Se havia uma operação em andamento, confira se ela foi salva antes de repeti-la.</p>
      <button onClick={() => retry()} style={{ padding: "14px 20px", cursor: "pointer" }}>Tentar novamente</button>
    </main>
  </body></html>;
}
