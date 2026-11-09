import { makePdf, type Snapshot } from "@/lib/event-report-pdf";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Report = { snapshot: Snapshot; pdf_base64: string | null };
const validEventId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function reportResponse(id: string) {
  if (!validEventId.test(id)) return Response.json({ error: "Evento inválido." }, { status: 404 });
  const client = await createClient();
  const { data, error } = await client.rpc("get_event_closure_report", { target_event: id });
  if (error || !data) return Response.json({ error: "Relatório não encontrado ou acesso não autorizado." }, { status: 403 });
  const report = data as Report;
  let bytes: Buffer;
  if (report.pdf_base64) bytes = Buffer.from(report.pdf_base64, "base64");
  else {
    bytes = await makePdf(report.snapshot);
    const { data: saved, error: saveError } = await client.rpc("save_event_closure_pdf", { target_event: id, encoded_pdf: bytes.toString("base64") });
    if (saveError || !saved) return Response.json({ error: "O evento foi encerrado, mas não foi possível salvar o PDF. Tente baixar novamente." }, { status: 500 });
    bytes = Buffer.from(saved as string, "base64");
  }
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="relatorio-evento-${id}.pdf"`, "Cache-Control": "private, no-store" } });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { return await reportResponse((await context.params).id); }
  catch { return Response.json({ error: "Não foi possível gerar o relatório." }, { status: 500 }); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const origin = request.headers.get("origin");
    const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").split(",")[0].trim();
    if (!origin || !host || new URL(origin).host !== host) return Response.json({ error: "Origem da solicitação inválida." }, { status: 403 });
    const { id } = await context.params;
    if (!validEventId.test(id)) return Response.json({ error: "Evento inválido." }, { status: 404 });
    const { error } = await (await createClient()).rpc("finalize_event_and_snapshot", { target_event: id });
    if (error) return Response.json({ error: /finish or resolve/i.test(error.message) ? "Conclua as apresentações e confrontos pendentes antes de encerrar." : "Não foi possível encerrar o evento. Confira suas permissões e o estado do evento." }, { status: 400 });
    return await reportResponse(id);
  } catch { return Response.json({ error: "Não foi possível concluir a operação. Verifique o estado do evento antes de tentar novamente." }, { status: 500 }); }
}
