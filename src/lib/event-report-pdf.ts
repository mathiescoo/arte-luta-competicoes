import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatAmount } from "./financial";

type Item = Record<string, unknown>;
export type Snapshot = { event: Item; form_fields: Item[]; registrations: Item[]; results: Item[]; scorecards: Item[]; matches: Item[] };

function readable(value: unknown, fallback = "Não informado") {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return (text || fallback).replace(/[–—\u00ad]/g, "-").replace(/[^\x20-\x7e\u00a0-\u00ff\n]/g, "?");
}
function dateLabel(value: unknown, time = false) {
  if (!value) return "Não informada";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return readable(value);
  return new Intl.DateTimeFormat("pt-BR", time
    ? { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }
    : { dateStyle: "long", timeZone: "UTC" }).format(date);
}
function group(items: Item[]) {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = `${readable(item.competition, "Competição não informada")} | ${readable(item.category, "Categoria não informada")}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return [...groups.entries()];
}

export async function makePdf(snapshot: Snapshot) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(.10, .16, .14), muted = rgb(.37, .42, .40), green = rgb(.04, .38, .22);
  const light = rgb(.95, .97, .95), line = rgb(.83, .87, .84);
  const margin = 44, width = 507;
  let page: PDFPage;
  let y = 0;

  function newPage() {
    page = pdf.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 818, width: 595, height: 24, color: green });
    page.drawText("ARENA ARTE LUTA  |  REGISTRO DO EVENTO", { x: margin, y: 826, size: 8, font: bold, color: rgb(1, 1, 1) });
    y = 794;
  }
  function ensure(height: number) { if (y - height < 50) newPage(); }
  function wrapped(value: unknown, font: PDFFont, size: number, maxWidth: number) {
    const words = readable(value).replace(/\s+/g, " ").split(" ");
    const lines: string[] = [];
    let current = "";
    for (let word of words) {
      if (current && font.widthOfTextAtSize(`${current} ${word}`, size) <= maxWidth) { current += ` ${word}`; continue; }
      if (current) { lines.push(current); current = ""; }
      while (font.widthOfTextAtSize(word, size) > maxWidth) {
        let length = 1;
        while (length < word.length && font.widthOfTextAtSize(word.slice(0, length + 1), size) <= maxWidth) length++;
        lines.push(word.slice(0, length)); word = word.slice(length);
      }
      current = word;
    }
    if (current) lines.push(current);
    return lines;
  }
  function text(value: unknown, options: { size?: number; strong?: boolean; indent?: number; color?: ReturnType<typeof rgb> } = {}) {
    const size = options.size || 10, font = options.strong ? bold : regular, indent = options.indent || 0;
    const lines = wrapped(value, font, size, width - indent);
    for (const part of lines) {
      ensure(size + 7);
      page.drawText(part, { x: margin + indent, y, size, font, color: options.color || ink });
      y -= size + 6;
    }
  }
  function section(title: string, description?: string) {
    ensure(description ? 68 : 50); y -= 12;
    page.drawRectangle({ x: margin, y: y - 5, width, height: 28, color: light });
    page.drawText(readable(title).toUpperCase(), { x: margin + 10, y: y + 4, size: 11, font: bold, color: green });
    y -= 24;
    if (description) text(description, { size: 9, color: muted });
    y -= 5;
  }
  function groupHeading(title: string) {
    ensure(64); y -= 6; text(title, { strong: true, size: 11, color: green });
    page.drawLine({ start: { x: margin, y: y + 4 }, end: { x: margin + width, y: y + 4 }, thickness: .5, color: line });
    y -= 10;
  }
  function record(title: unknown, lines: Array<string>) {
    ensure(54); text(title, { strong: true, size: 10 });
    for (const value of lines) text(value, { size: 9, indent: 10 });
    y -= 7;
  }
  newPage();
  text("Relatório de encerramento", { size: 19, strong: true, color: green });
  text(snapshot.event.name, { size: 15, strong: true });
  y -= 4;
  text(`Data do evento: ${dateLabel(snapshot.event.starts_at)}`);
  text(`Local: ${readable(snapshot.event.venue)}  |  Cidade: ${readable(snapshot.event.city)}`);
  text(`Registro encerrado em: ${dateLabel(snapshot.event.closed_at, true)} (horário de Brasília)`, { color: muted, size: 9 });
  const registrations = snapshot.registrations || [], results = snapshot.results || [], scorecards = snapshot.scorecards || [], matches = snapshot.matches || [];
  section("Resumo do evento");
  text(`Inscrições: ${registrations.length}  |  Presenças confirmadas: ${registrations.filter((r) => r.attendance_confirmed === true).length}`);
  text(`Resultados: ${results.length}  |  Fichas de notas: ${scorecards.length}  |  Confrontos: ${matches.length}`);
  text(snapshot.event.requires_payment === true
    ? `Pagamento exigido: ${registrations.filter((r) => r.payment_confirmed === true).length} inscrição(ões) confirmada(s).`
    : "Pagamento não exigido para este evento.");
  const financial = snapshot.event.financial && typeof snapshot.event.financial === "object" ? snapshot.event.financial as Item : {};
  section("Prestação de contas", "Valores informados manualmente pela organização, quando disponíveis.");
  text(`Receitas totais: ${formatAmount(financial.income_cents)}`);
  text(`Despesas totais: ${formatAmount(financial.expenses_cents)}`);
  if (typeof financial.income_cents === "number" && Number.isSafeInteger(financial.income_cents) && financial.income_cents >= 0
    && typeof financial.expenses_cents === "number" && Number.isSafeInteger(financial.expenses_cents) && financial.expenses_cents >= 0) {
    text(`Saldo informado: ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format((financial.income_cents - financial.expenses_cents) / 100)}`);
  } else text("Saldo: não calculado, pois falta informar receita ou despesa.");
  if (financial.notes) text(`Observações: ${readable(financial.notes)}`);
  text("O sistema não processa cobranças nem verifica comprovantes; os valores são declarados pela organização.", { size: 9, color: muted });

  section("Participantes e inscrições", "Organizados por competição e categoria.");
  if (!registrations.length) text("Nenhuma inscrição registrada.");
  for (const [heading, entries] of group(registrations)) {
    groupHeading(heading);
    for (const item of entries) {
      const lines = [`Idade: ${readable(item.age)}  |  Presença: ${item.attendance_confirmed ? "confirmada" : "não confirmada"}`];
      if (item.song || item.author) lines.push(`Música: ${readable(item.song)}  |  Autor / intérprete: ${readable(item.author)}`);
      if (snapshot.event.requires_payment === true) lines.push(`Pagamento: ${item.payment_confirmed ? "confirmado" : "não confirmado"}`);
      const extra = item.additional_data && typeof item.additional_data === "object" ? item.additional_data as Item : {};
      const labels = extra._labels && typeof extra._labels === "object" ? extra._labels as Item : {};
      const fields = snapshot.form_fields || [];
      const keys = new Set([...Object.keys(labels), ...fields.map((f) => String(f.key || ""))]);
      for (const key of keys) if (key && extra[key] != null && extra[key] !== "") lines.push(`${readable(labels[key] || fields.find((f) => f.key === key)?.label || key)}: ${readable(extra[key])}`);
      record(item.name, lines);
    }
  }
  section("Classificações", "Posições e resultados registrados no momento do encerramento.");
  if (!results.length) text("Nenhum resultado registrado.");
  for (const [heading, entries] of group(results)) {
    groupHeading(heading);
    for (const item of entries) record(`${readable(item.position, "-")}º lugar - ${readable(item.name)}`, [
      ...(item.total !== null && item.total !== undefined ? [`Pontuação: ${readable(item.total)}`] : []),
      item.published ? "Resultado publicado" : "Resultado não publicado",
    ]);
  }
  section("Fichas dos jurados", "Médias e critérios registrados, incluindo correções administrativas.");
  if (!scorecards.length) text("Nenhuma ficha de notas registrada.");
  for (const [heading, entries] of group(scorecards)) {
    groupHeading(heading);
    for (const card of entries) {
      const lines = [`Jurado: ${readable(card.judge)}  |  Média da ficha: ${readable(card.average)}`];
      for (const criterion of (Array.isArray(card.criteria) ? card.criteria as Item[] : [])) lines.push(`${readable(criterion.name)}: ${readable(criterion.score)} (escala ${readable(criterion.minimum)} a ${readable(criterion.maximum)})`);
      if (card.note) lines.push(`Observação: ${readable(card.note)}`);
      if (card.admin_edit_reason) lines.push(`Correção administrativa: ${readable(card.admin_edit_reason)} - ${dateLabel(card.admin_edited_at, true)}`);
      record(card.name, lines);
    }
  }
  section("Confrontos e votos", "Jogos de Campeonato Interno e Festival Mirim.");
  if (!matches.length) text("Nenhum confronto registrado.");
  for (const [heading, entries] of group(matches)) {
    groupHeading(heading);
    for (const match of entries) {
      const lines = [`Azul: ${readable(match.blue)}  |  Verde: ${readable(match.green)}`, `Vencedor: ${readable(match.winner)}`];
      for (const vote of (Array.isArray(match.votes) ? match.votes as Item[] : [])) lines.push(`Jurado: ${readable(vote.judge)}  |  Bandeira: ${vote.color === "blue" ? "azul" : vote.color === "green" ? "verde" : "não informada"}`);
      record(readable(match.phase, "Confronto"), lines);
    }
  }
  const pages = pdf.getPages();
  for (const [index, reportPage] of pages.entries()) {
    reportPage.drawLine({ start: { x: margin, y: 38 }, end: { x: margin + width, y: 38 }, thickness: .5, color: line });
    reportPage.drawText("Registro preservado para consulta", { x: margin, y: 23, size: 8, font: regular, color: muted });
    const label = `Página ${index + 1} de ${pages.length}`;
    reportPage.drawText(label, { x: margin + width - regular.widthOfTextAtSize(label, 8), y: 23, size: 8, font: regular, color: muted });
  }
  return Buffer.from(await pdf.save());
}
