export type ParticipantSummary = { full_name: string };
export type ParticipantRelation = ParticipantSummary | ParticipantSummary[] | null;

/**
 * PostgREST returns a to-one relation as an object. Keeping this small
 * adapter also tolerates older cached payloads that may still be arrays.
 */
export function participantName(participant: ParticipantRelation, fallback = "Participante") {
  if (Array.isArray(participant)) return participant[0]?.full_name || fallback;
  return participant?.full_name || fallback;
}
