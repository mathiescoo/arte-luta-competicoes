import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makePdf } from "./event-report-pdf";

describe("relatório de evento", () => {
  it("gera um PDF paginado com inscrições, notas históricas e votos", async () => {
    const pdf = await makePdf({
      event: { name: "Campeonato de Capoeira", city: "Brasília", venue: "Ginásio", closed_at: "2026-11-08" },
      form_fields: [{ key: "professor", label: "Professor" }],
      registrations: Array.from({ length: 90 }, (_, index) => ({ name: `Participante ${index}`, category: "Infantil", competition: "Musicalidade", additional_data: { professor: "Professora de capoeira" } })),
      results: [{ name: "Participante 1", competition: "Musicalidade", category: "Infantil", position: 1, total: 8.75 }],
      scorecards: [{ name: "Participante 1", judge: "Juíza", competition: "Musicalidade", category: "Infantil", average: 8.75, criteria: [{ name: "Expressão", score: 8.75, minimum: 0, maximum: 10 }] }],
      matches: [{ competition: "Interno", category: "Adulto", blue: "Azul", green: "Verde", winner: "Azul", votes: [{ judge: "Juiz", color: "blue" }] }],
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
  });
});
