type Registration = { event_id: string };
type Participant = { registrations: Registration[] };

/** Keep historical registrations in storage, but do not send them to the active-events workspace. */
export function participantsForActiveEvents<T extends Participant>(participants: T[], eventIds: ReadonlySet<string>) {
  return participants.flatMap((participant) => {
    const registrations = participant.registrations.filter((registration) => eventIds.has(registration.event_id));
    return registrations.length ? [{ ...participant, registrations, total_registration_count: participant.registrations.length }] : [];
  });
}
