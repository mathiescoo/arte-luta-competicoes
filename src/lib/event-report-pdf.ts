import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

type Item = Record<string, unknown>;
export type Snapshot = { event: Item; form_fields: Item[]; registrations: Item[]; results: Item[]; scorecards: Item[]; matches: Item[] };

function readable(value: unknown) {
  return String(value ?? "-").replace(/[–—\u00ad]/g, "-").replace(/[^\x20-\x7e\u00a0-\u00ff\n]/g, "?");
}

export async function makePdf(snapshot: Snapshot) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 796;
  function ensureSpace(lines: number) {
    if (y - Math.min(lines, 8) * 14 < 45) { page = pdf.addPage([595, 842]); y = 796; }
  }
  function write(value: string, isHeading = false) {
    if (isHeading) ensureSpace(3);
    const words = readable(value).split(/\s+/);
    let line = "";
    const size = isHeading ? 13 : 10;
    const usedFont = isHeading ? bold : font;
    const draw = (text: string) => {
      if (y < 45) { page = pdf.addPage([595, 842]); y = 796; }
      page.drawText(text, { x: 42, y, size, font: usedFont, color: rgb(0.12, 0.16, 0.14) });
      y -= isHeading ? 19 : 14;
    };
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (usedFont.widthOfTextAtSize(next, size) > 510 && line) { draw(line); line = ""; }
      for (const character of word) {
        if (usedFont.widthOfTextAtSize(line + character, size) > 510 && line) { draw(line); line = ""; }
        line += character;
      }
      if (usedFont.widthOfTextAtSize(next, size) <= 510 && next !== word) line = next;
    }
    if (line) draw(line);
  }
  write(`Relatório de encerramento — ${readable(snapshot.event.name)}`, true);
  write(`Evento: ${readable(snapshot.event.name)} | Local: ${readable(snapshot.event.venue)} | Cidade: ${readable(snapshot.event.city)}`);
  write(`Data do evento: ${readable(snapshot.event.starts_at)} | Encerrado em: ${readable(snapshot.event.closed_at)}`);
  write("Participantes e inscrições", true);
  for (const item of snapshot.registrations) {
    ensureSpace(3);
    const payment = snapshot.event.requires_payment === true ? (item.payment_confirmed ? "confirmado" : "não confirmado") : "não exigido";
    write(`${readable(item.name)} | ${readable(item.competition)} | ${readable(item.category)} | Idade: ${readable(item.age)} | Música: ${readable(item.song)} | Autor: ${readable(item.author)} | Presença: ${item.attendance_confirmed ? "sim" : "não"} | Pagamento: ${payment}`);
    const extra = item.additional_data && typeof item.additional_data === "object" ? item.additional_data as Item : {};
    const savedLabels = extra._labels && typeof extra._labels === "object" ? extra._labels as Item : {};
    const keys = new Set([...Object.keys(savedLabels), ...(snapshot.form_fields || []).map((field) => String(field.key || ""))]);
    for (const key of keys) if (key && extra[key] != null) {
      const fallback = (snapshot.form_fields || []).find((field) => field.key === key)?.label;
      write(`  ${readable(savedLabels[key] || fallback || key)}: ${readable(extra[key])}`);
    }
  }
  if (!snapshot.registrations.length) write("Nenhuma inscrição registrada.");
  write("Classificações", true);
  for (const item of snapshot.results) write(`${readable(item.competition)} | ${readable(item.category)} | ${readable(item.position)}º | ${readable(item.name)} | Nota: ${readable(item.total)} | ${item.published ? "Publicado" : "Não publicado"}`);
  if (!snapshot.results.length) write("Nenhum resultado registrado.");
  write("Fichas de avaliação", true);
  for (const card of snapshot.scorecards) {
    ensureSpace(3);
    write(`${readable(card.name)} | ${readable(card.competition)} | ${readable(card.category)} | Jurado: ${readable(card.judge)} | Média: ${readable(card.average)}`);
    for (const criterion of (Array.isArray(card.criteria) ? card.criteria as Item[] : [])) write(`  ${readable(criterion.name)}: ${readable(criterion.score)} (${readable(criterion.minimum)} a ${readable(criterion.maximum)})`);
    if (card.note) write(`  Observação: ${readable(card.note)}`);
    if (card.admin_edit_reason) write(`  Correção administrativa: ${readable(card.admin_edit_reason)} | ${readable(card.admin_edited_at)}`);
  }
  if (!snapshot.scorecards.length) write("Nenhuma ficha registrada.");
  write("Confrontos e votos", true);
  for (const match of snapshot.matches) {
    ensureSpace(3);
    write(`${readable(match.competition)} | ${readable(match.category)} | ${readable(match.phase)} | Azul: ${readable(match.blue)} | Verde: ${readable(match.green)} | Vencedor: ${readable(match.winner)}`);
    for (const vote of (Array.isArray(match.votes) ? match.votes as Item[] : [])) write(`  Jurado: ${readable(vote.judge)} | Voto: ${vote.color === "blue" ? "azul" : "verde"}`);
  }
  if (!snapshot.matches.length) write("Nenhum confronto registrado.");
  for (const [index, reportPage] of pdf.getPages().entries()) {
    reportPage.drawText(`Página ${index + 1} de ${pdf.getPageCount()}`, { x: 42, y: 22, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
  }
  return Buffer.from(await pdf.save());
}
