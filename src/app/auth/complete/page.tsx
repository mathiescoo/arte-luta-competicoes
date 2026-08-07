"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export default function CompleteAuthPage() {
  useEffect(() => {
    async function complete() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const next = url.searchParams.get("next");
      const destination = next?.startsWith("/") ? next : "/painel";

      if (!code) {
        window.location.replace("/entrar?erro=oauth");
        return;
      }

      const { error } = await createClient().auth.exchangeCodeForSession(code);
      window.location.replace(error ? "/entrar?erro=oauth" : destination);
    }

    void complete();
  }, []);

  return null;
}
