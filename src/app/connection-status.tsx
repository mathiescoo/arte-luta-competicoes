"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export default function ConnectionStatus() {
  const offline = useSyncExternalStore(subscribe, () => !navigator.onLine, () => false);
  if (!offline) return null;
  return <aside className="connection-warning" role="alert">
    <strong>Sem conexão com a internet.</strong> As informações podem estar desatualizadas.
    Não feche esta página; aguarde a conexão voltar e confira se a última operação foi salva antes de repeti-la.
  </aside>;
}
