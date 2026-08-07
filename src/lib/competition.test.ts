import { describe, expect, it } from "vitest";
import { flagResult, musicalityTotal, shouldHideRanking } from "./competition";

describe("musicalidade", () => {
  it("soma todas as notas sem calcular média", () => expect(musicalityTotal([
    { judgeId: "1", scores: { a: 8, b: 9, c: 8, d: 10, e: 9 } },
    { judgeId: "2", scores: { a: 9, b: 8, c: 9, d: 9, e: 8 } },
    { judgeId: "3", scores: { a: 8, b: 10, c: 9, d: 10, e: 9 } },
  ], ["1", "2", "3"])).toEqual({ complete: true, total: 133 }));
  it("não ranqueia com avaliação pendente", () => expect(musicalityTotal([{ judgeId: "1", scores: { a: 10 } }], ["1", "2"]).total).toBeNull());
  it("ativa modo mistério nos três finais", () => expect(shouldHideRanking(8, 3)).toBe(true));
});

describe("bandeiras", () => {
  it.each([
    [["blue", "blue", "blue"], "blue", "3 a 0"], [["blue", "green", "blue"], "blue", "2 a 1"],
    [["green", "green", "green"], "green", "3 a 0"], [["green", "blue", "green"], "green", "2 a 1"],
  ] as const)("apura maioria", (votes, winner, score) => expect(flagResult([...votes])).toMatchObject({ complete: true, winner, score }));
  it("bloqueia resultado antes de três votos", () => expect(flagResult(["blue", "green"]).complete).toBe(false));
});
