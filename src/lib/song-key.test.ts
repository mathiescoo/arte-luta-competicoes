import { describe, expect, it } from "vitest";
import { songKey } from "./song-key";

describe("comparação de músicas", () => {
  it("ignora acentos, pontuação e diferenças de maiúsculas", () => {
    expect(songKey("  Canção da Roda! ")).toBe(songKey("cancao-da-roda"));
  });
  it("não confunde títulos distintos", () => {
    expect(songKey("Canção de Angola")).not.toBe(songKey("Canção da Bahia"));
    expect(songKey("")).toBe("");
  });
});
