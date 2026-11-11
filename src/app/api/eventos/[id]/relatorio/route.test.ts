import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), makePdf: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/event-report-pdf", () => ({ makePdf: mocks.makePdf }));
import { GET, POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id }) };
const url = `https://arena.example/api/eventos/${id}/relatorio`;
const pdf = Buffer.from("%PDF-1.7\nRelatorio de teste");
const validHeaders = { origin: "https://arena.example", host: "arena.example" };

beforeEach(() => { vi.resetAllMocks(); });

describe("proteção e recuperação do relatório de encerramento", () => {
  it("nega download sem autorização e não gera PDF", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "not authorized" } });
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(403);
    expect(mocks.makePdf).not.toHaveBeenCalled();
  });

  it.each([new Headers(), new Headers({ origin: "https://outro.example", host: "arena.example" })])("recusa encerramento sem origem válida: %j", async (headers) => {
    const response = await POST(new Request(url, { method: "POST", headers }), context);
    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("não consulta o banco para um identificador inválido", async () => {
    const response = await GET(new Request(url), { params: Promise.resolve({ id: "invalido" }) });
    expect(response.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("orienta a concluir apresentações pendentes antes de encerrar", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "finish or resolve all presentations and matches before closing the event" } });
    const response = await POST(new Request(url, { method: "POST", headers: validHeaders }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("pendentes");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("preserva o PDF original e permite baixá-lo sem substituição", async () => {
    mocks.rpc.mockResolvedValue({ data: { snapshot: {}, pdf_base64: pdf.toString("base64") }, error: null });
    const response = await GET(new Request(`${url}?original=1`), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf);
    expect(mocks.makePdf).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("gera uma versão organizada a partir do histórico sem alterar o PDF original", async () => {
    const snapshot = { event: { name: "Teste" } };
    const updatedPdf = Buffer.from("%PDF-1.7\nVersão organizada");
    mocks.rpc.mockResolvedValue({ data: { snapshot, pdf_base64: pdf.toString("base64") }, error: null });
    mocks.makePdf.mockResolvedValue(updatedPdf);
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(updatedPdf);
    expect(mocks.makePdf).toHaveBeenCalledWith(snapshot);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("recupera o PDF ausente a partir do registro preservado", async () => {
    const snapshot = { event: { name: "Teste" } };
    mocks.rpc.mockResolvedValueOnce({ data: { snapshot, pdf_base64: null }, error: null })
      .mockResolvedValueOnce({ data: pdf.toString("base64"), error: null });
    mocks.makePdf.mockResolvedValue(pdf);
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(200);
    expect(mocks.makePdf).toHaveBeenCalledWith(snapshot);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "save_event_closure_pdf", { target_event: id, encoded_pdf: pdf.toString("base64") });
  });

  it("não afirma sucesso quando o PDF não foi salvo", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { snapshot: {}, pdf_base64: null }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "failed" } });
    mocks.makePdf.mockResolvedValue(pdf);
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("Tente baixar novamente");
  });

  it("encerra antes de disponibilizar o relatório", async () => {
    mocks.rpc.mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ data: { snapshot: {}, pdf_base64: pdf.toString("base64") }, error: null });
    mocks.makePdf.mockResolvedValue(pdf);
    const response = await POST(new Request(url, { method: "POST", headers: validHeaders }), context);
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "finalize_event_and_snapshot", { target_event: id });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "get_event_closure_report", { target_event: id });
  });

  it("não revela detalhes internos quando a conexão falha", async () => {
    mocks.rpc.mockRejectedValue(new Error("detalhe interno"));
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("detalhe interno");
  });
});
