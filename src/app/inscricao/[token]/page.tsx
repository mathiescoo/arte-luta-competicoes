import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PublicRegistration from "./public-registration";

export const dynamic = "force-dynamic";

export default async function RegistrationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) notFound();
  const { data, error } = await (await createClient()).rpc("public_registration_form", { form_token: token });
  if (error) throw new Error("Não foi possível consultar o formulário.");
  if (!data) return <main className="management-page"><h1>Inscrições indisponíveis</h1><p>Este formulário não está aberto. Entre em contato com a organização.</p></main>;
  return <PublicRegistration token={token} form={data} />;
}
