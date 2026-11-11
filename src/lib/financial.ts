/** Values are stored in integer cents. A blank amount is unknown, not zero. */
export function parseAmountCents(value: string): number | null | undefined {
  const input = value.trim().replace(",", ".");
  if (!input) return null;
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(input)) return undefined;
  const [whole, fractional = ""] = input.split(".");
  const cents = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

export function amountInput(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? (value / 100).toFixed(2) : "";
}

export function formatAmount(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value / 100)
    : "Não informado";
}
