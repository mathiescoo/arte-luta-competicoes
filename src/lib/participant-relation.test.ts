import { describe, expect, it } from "vitest";
import { participantName } from "./participant-relation";

describe("participantName", () => {
  it("lê a relação to-one devolvida pelo Supabase", () => {
    expect(participantName({ full_name: "Ana Júlia" })).toBe("Ana Júlia");
  });

  it("mantém compatibilidade com uma relação em lista", () => {
    expect(participantName([{ full_name: "Carlos" }])).toBe("Carlos");
  });

  it("usa um nome seguro quando a relação não existe", () => {
    expect(participantName(null)).toBe("Participante");
  });
});
