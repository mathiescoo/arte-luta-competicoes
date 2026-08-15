"use client";

import { ChangeEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FileUp, X } from "lucide-react";
import { strFromU8, unzipSync } from "fflate";
import { createClient } from "@/lib/supabase/client";

type EventItem = {
  id: string;
  name: string;
  competitions: Array<{
    id: string;
    name: string;
    categories: Array<{ id: string; name: string }>;
  }>;
};

type CategoryOption = { id: string; name: string; competition: string };
type ImportRow = Record<string, string>;
type StoredParticipant = { id: string; full_name: string; private_data: Record<string, unknown> | null };

const maximumImportSize = 5 * 1024 * 1024;

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function inlineText(xml: string) {
  return Array.from(xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g), (match) => decodeXml(match[1])).join("");
}

function sharedStrings(xml: string) {
  return Array.from(xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), (match) => inlineText(match[1]));
}

function columnIndex(reference: string) {
  const letters = reference.replace(/\d/g, "").toUpperCase();
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function spreadsheetCell(attributes: string, content: string, strings: string[]) {
  const type = attributes.match(/\bt="([^"]+)"/)?.[1];
  if (type === "inlineStr") return inlineText(content);
  const value = content.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "";
  if (type === "s") return strings[Number.parseInt(value, 10)] || "";
  return decodeXml(value);
}

function parseXlsx(buffer: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const worksheetPath = Object.keys(files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort()[0];
  if (!worksheetPath) return [] as ImportRow[];

  const stringsFile = files["xl/sharedStrings.xml"];
  const strings = stringsFile ? sharedStrings(strFromU8(stringsFile)) : [];
  const worksheet = strFromU8(files[worksheetPath]);
  const parsedRows: ImportRow[] = [];
  let headers: string[] = [];

  for (const rowMatch of worksheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const values: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const reference = cellMatch[1].match(/\br="([A-Z]+\d+)"/i)?.[1];
      if (!reference) continue;
      values[columnIndex(reference)] = spreadsheetCell(cellMatch[1], cellMatch[2], strings);
    }

    if (!headers.length) {
      headers = values.map((value) => text(value));
      continue;
    }

    const row = headers.reduce<ImportRow>((result, header, index) => {
      if (header) result[header] = text(values[index]);
      return result;
    }, {});
    if (Object.values(row).some(Boolean)) parsedRows.push(row);
  }

  return parsedRows;
}

function delimiterFrom(content: string) {
  const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  return (firstLine.match(/;/g)?.length || 0) > (firstLine.match(/,/g)?.length || 0) ? ";" : ",";
}

function parseDelimited(content: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];
    if (character === "\"") {
      if (quoted && nextCharacter === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && nextCharacter === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += character;
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

async function parseFile(file: File) {
  if (/\.xlsx$/i.test(file.name)) return parseXlsx(await file.arrayBuffer());
  const content = await file.text();
  const rows = parseDelimited(content, delimiterFrom(content));
  const headers = rows.shift()?.map((header) => text(header)) || [];
  return rows.map((values) => headers.reduce<ImportRow>((result, header, index) => {
    if (header) result[header] = text(values[index]);
    return result;
  }, {}));
}

function valueFrom(row: ImportRow, matches: (header: string) => boolean) {
  for (const [header, value] of Object.entries(row)) {
    if (matches(normalize(header)) && text(value)) return text(value);
  }
  return "";
}

function ageValue(value: string) {
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) && Number.isInteger(number) ? String(number) : value;
}

function musicRegistrationFrom(row: ImportRow) {
  return {
    fullName: valueFrom(row, (header) => header === "nome completo" || header === "nome" || header === "name"),
    age: ageValue(valueFrom(row, (header) => header === "idade" || header === "age")),
    category: valueFrom(row, (header) => header === "categoria" || header === "category"),
    phone: valueFrom(row, (header) => header.includes("numero para contato") || header === "telefone" || header === "phone" || header === "celular"),
    teacher: valueFrom(row, (header) => header.includes("polo professor mestre") || header === "professor" || header === "mestre" || header === "polo"),
    songTitle: valueFrom(row, (header) => header.startsWith("qual musica voce vai cantar") || header === "musica" || header === "musica que vai cantar"),
    songAuthor: valueFrom(row, (header) => header.startsWith("autor da musica") || header === "autor"),
  };
}

function matchingCategory(sourceCategory: string, categories: CategoryOption[]) {
  const source = normalize(sourceCategory);
  if (!source) return undefined;

  const exact = categories.find((category) => normalize(category.name) === source);
  if (exact) return exact;

  const partial = categories.filter((category) => {
    const target = normalize(category.name);
    return source.startsWith(target) || target.startsWith(source);
  });
  if (partial.length === 1) return partial[0];

  const sourceGroup = source.split(" ")[0];
  const sameGroup = categories.filter((category) => normalize(category.name).split(" ")[0] === sourceGroup);
  return sameGroup.length === 1 ? sameGroup[0] : undefined;
}

function mergeDetails(existing: Record<string, unknown> | null, next: Record<string, string>) {
  const merged: Record<string, unknown> = { ...(existing || {}) };
  Object.entries(next).forEach(([key, value]) => {
    if (value) merged[key] = value;
  });
  return merged;
}

export default function CsvImporter({ organizationId, events }: { organizationId: string; events: EventItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [eventId, setEventId] = useState(events[0]?.id || "");
  const [categoryId, setCategoryId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const event = events.find((item) => item.id === eventId);
  const categories = useMemo(
    () => event?.competitions.flatMap((competition) =>
      competition.categories.map((category) => ({ ...category, competition: competition.name })),
    ) || [],
    [event],
  );

  async function importFile(eventChange: ChangeEvent<HTMLInputElement>) {
    const file = eventChange.target.files?.[0];
    if (!file || !eventId) return;
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setError("Selecione a planilha Excel (.xlsx) ou um CSV.");
      return;
    }
    if (file.size > maximumImportSize) {
      setError("A planilha deve ter no máximo 5 MB.");
      return;
    }

    setError("");
    setMessage("");
    setLoading(true);

    let rows: ImportRow[];
    try {
      rows = await parseFile(file);
    } catch {
      setError("Não foi possível ler esse arquivo. Salve-o como .xlsx ou .csv e tente novamente.");
      setLoading(false);
      return;
    }

    if (!rows.length) {
      setError("A planilha precisa de cabeçalho e ao menos um participante.");
      setLoading(false);
      return;
    }

    const samples = rows.map(musicRegistrationFrom);
    if (!samples.some((row) => row.fullName)) {
      setError("Não encontramos a coluna “Nome completo” na planilha.");
      setLoading(false);
      return;
    }

    const hasCategoryInSheet = samples.some((row) => row.category);
    if (!hasCategoryInSheet && !categoryId) {
      setError("Selecione uma categoria padrão ou use uma planilha com a coluna “Categoria”.");
      setLoading(false);
      return;
    }

    const supabase = createClient();
    const { data: storedParticipants, error: participantLoadError } = await supabase
      .from("participants")
      .select("id,full_name,private_data")
      .eq("organization_id", organizationId);

    if (participantLoadError) {
      setError(participantLoadError.message || "Não foi possível preparar a importação.");
      setLoading(false);
      return;
    }

    const participantsByName = new Map<string, StoredParticipant>();
    ((storedParticipants || []) as StoredParticipant[]).forEach((participant) => {
      if (!participantsByName.has(normalize(participant.full_name))) {
        participantsByName.set(normalize(participant.full_name), participant);
      }
    });

    let imported = 0;
    let duplicates = 0;
    let failed = 0;
    let unmatchedCategories = 0;
    const seen = new Set<string>();
    const fallbackCategory = categories.find((category) => category.id === categoryId);

    for (const row of samples) {
      if (!row.fullName) {
        failed += 1;
        continue;
      }

      const targetCategory = row.category ? matchingCategory(row.category, categories) : fallbackCategory;
      if (!targetCategory) {
        unmatchedCategories += 1;
        continue;
      }

      const identity = `${normalize(row.fullName)}|${targetCategory.id}`;
      if (seen.has(identity)) {
        duplicates += 1;
        continue;
      }
      seen.add(identity);

      const knownParticipant = participantsByName.get(normalize(row.fullName));
      let participantId = knownParticipant?.id || "";
      const privateData = mergeDetails(knownParticipant?.private_data || null, { phone: row.phone, teacher: row.teacher });

      if (knownParticipant) {
        const { error: updateError } = await supabase
          .from("participants")
          .update({ private_data: privateData })
          .eq("id", knownParticipant.id);
        if (updateError) {
          failed += 1;
          continue;
        }
      } else {
        const { data: participant, error: participantError } = await supabase
          .from("participants")
          .insert({ organization_id: organizationId, full_name: row.fullName, private_data: privateData })
          .select("id,full_name,private_data")
          .single();
        if (participantError || !participant) {
          failed += 1;
          continue;
        }
        participantId = participant.id;
        participantsByName.set(normalize(row.fullName), participant as StoredParticipant);
      }

      if (!participantId) {
        failed += 1;
        continue;
      }

      const { error: registrationError } = await supabase
        .from("registrations")
        .upsert({
          event_id: eventId,
          participant_id: participantId,
          category_id: targetCategory.id,
          data: {
            source: "spreadsheet",
            age: row.age,
            song_title: row.songTitle,
            song_author: row.songAuthor,
            source_category: row.category || targetCategory.name,
          },
        }, { onConflict: "event_id,participant_id,category_id" });

      if (registrationError) failed += 1;
      else imported += 1;
    }

    const details = [
      `${imported} inscrição(ões) importada(s) ou atualizada(s)`,
      duplicates ? `${duplicates} duplicada(s) ignorada(s)` : "",
      unmatchedCategories ? `${unmatchedCategories} com categoria não encontrada` : "",
      failed ? `${failed} linha(s) com erro` : "",
    ].filter(Boolean);
    setMessage(`${details.join(" · ")}.`);
    setLoading(false);
    eventChange.target.value = "";
    router.refresh();
  }

  function template() {
    const data = [
      "Nome completo;Idade;Categoria;Número para contato (DDD)9xxxx-xxxx;QUAL POLO/PROFESSOR/MESTRE /MESTRANDO/ OU CONTA MESTRE;Qual música você vai cantar?;Autor da música? (Quem canta a música escolhida?)",
      "Maria da Silva;14;Juvenil (11 a 15 anos);61999999999;CEF 05 DO GAMA - PROFESSOR MATHEUS;Angola;Mestre Pastinha",
    ].join("\n");
    const blob = new Blob([data], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "modelo-cante-comigo.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <button className="secondary csv-trigger" onClick={() => setOpen(true)}><FileUp />Importar planilha</button>
      {open && (
        <div className="modal-wrap">
          <button className="backdrop" onClick={() => setOpen(false)} aria-label="Fechar" />
          <div className="modal category-modal">
            <button className="modal-x" onClick={() => setOpen(false)}><X /></button>
            <span className="eyebrow">IMPORTAÇÃO EM LOTE</span>
            <h2>Importar participantes</h2>
            <p>Envie o Excel do formulário ou um CSV. A importação reconhece nome, idade, categoria, música e autor; os dados aparecerão na ficha dos jurados.</p>
            <div className="form-grid">
              <label>Evento<select value={eventId} onChange={(eventChange) => { setEventId(eventChange.target.value); setCategoryId(""); }}>{events.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
              <label>Categoria padrão (opcional)<select value={categoryId} onChange={(eventChange) => setCategoryId(eventChange.target.value)}><option value="">Usar a categoria da planilha</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.competition} · {category.name}</option>)}</select></label>
            </div>
            <p className="import-help">Se a planilha tiver a coluna <b>Categoria</b>, ela será usada automaticamente. A categoria padrão serve apenas para arquivos sem essa coluna.</p>
            <button className="download-template" onClick={template}><Download />Baixar modelo CSV</button>
            <label className="file-picker">Selecionar Excel ou CSV<input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" disabled={loading || !eventId} onChange={importFile} /></label>
            {error && <div className="form-error">{error}</div>}
            {message && <div className="login-success">{message}</div>}
            {loading && <p>Importando participantes. Não feche esta janela.</p>}
          </div>
        </div>
      )}
    </>
  );
}
