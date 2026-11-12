import { describe, expect, it } from "vitest";
import { participantsForActiveEvents } from "./active-event-participants";

describe("inscrições de eventos atuais", () => {
  const participants = [
    { id: "antigo", registrations: [{ event_id: "encerrado", id: "1" }] },
    { id: "ambos", registrations: [{ event_id: "encerrado", id: "2" }, { event_id: "atual", id: "3" }] },
    { id: "atual", registrations: [{ event_id: "atual", id: "4" }] },
  ];

  it("não mostra inscrições apenas de eventos encerrados", () => {
    const current = participantsForActiveEvents(participants, new Set(["atual"]));
    expect(current.map((participant) => participant.id)).toEqual(["ambos", "atual"]);
    expect(current[0].registrations).toEqual([{ event_id: "atual", id: "3" }]);
    expect(current[0].total_registration_count).toBe(2);
  });

  it("não mostra participantes quando não há evento atual", () => {
    expect(participantsForActiveEvents(participants, new Set())).toEqual([]);
    expect(participants[0].registrations).toHaveLength(1);
  });
});
