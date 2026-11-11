import { describe, expect, it } from "vitest";
import { amountInput, formatAmount, parseAmountCents } from "./financial";

describe("prestação de contas manual", () => {
  it("distingue ausência de informação de zero", () => {
    expect(parseAmountCents("")).toBeNull();
    expect(parseAmountCents("0")).toBe(0);
    expect(amountInput(null)).toBe("");
    expect(formatAmount(null)).toBe("Não informado");
  });
  it("converte valores para centavos sem erros de arredondamento", () => {
    expect(parseAmountCents("15,50")).toBe(1550);
    expect(parseAmountCents("0.29")).toBe(29);
    expect(amountInput(1550)).toBe("15.50");
  });
  it("rejeita valores negativos, inválidos ou com mais de dois decimais", () => {
    expect(parseAmountCents("-1")).toBeUndefined();
    expect(parseAmountCents("1.001")).toBeUndefined();
    expect(parseAmountCents("abc")).toBeUndefined();
  });
});
