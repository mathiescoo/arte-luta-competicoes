/** Matches titles without case, spacing, punctuation or common accent differences. */
export function songKey(title: unknown): string {
  return String(title ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^\p{L}\p{N}]+/gu, "");
}
