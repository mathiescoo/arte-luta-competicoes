"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, CreditCard, Search, UserCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { participantName, type ParticipantRelation } from "@/lib/participant-relation";

type Event = { id: string; name: string; settings: Record<string, unknown> };
type Registration = {
  id: string;
  event_id: string;
  attendance_confirmed: boolean;
  payment_confirmed: boolean;
  participants: ParticipantRelation;
};

export default function CheckinManager({
  initialEvents,
  initialRegistrations,
  initialError = "",
}: {
  initialEvents: Event[];
  initialRegistrations: Registration[];
  initialError?: string;
}) {
  const router = useRouter();
  const [eventId, setEventId] = useState(() => initialEvents.find((event) =>
    initialRegistrations.some((registration) => registration.event_id === event.id),
  )?.id || initialEvents[0]?.id || "");
  const [registrations, setRegistrations] = useState(initialRegistrations);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(initialError);
  const [loadingId, setLoadingId] = useState("");
  const event = initialEvents.find((item) => item.id === eventId);
  const requiresPayment = event?.settings?.require_payment === true;
  const visible = useMemo(() => registrations.filter((registration) =>
    registration.event_id === eventId
    && participantName(registration.participants).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  ), [registrations, eventId, query]);
  const checkins = visible.filter((registration) => registration.attendance_confirmed).length;

  async function toggle(registration: Registration, column: "attendance_confirmed" | "payment_confirmed") {
    setError("");
    setLoadingId(registration.id);
    const next = !registration[column];
    const { error: updateError } = await createClient()
      .from("registrations")
      .update({ [column]: next })
      .eq("id", registration.id);

    if (updateError) {
      setError(updateError.message);
      setLoadingId("");
      return;
    }

    setRegistrations((items) => items.map((item) => item.id === registration.id
      ? { ...item, [column]: next }
      : item));
    setLoadingId("");
    router.refresh();
  }

  return (
    <section className="checkin-workspace">
      <div className="checkin-tools">
        <label>
          Evento
          <select value={eventId} onChange={(eventChange) => setEventId(eventChange.target.value)}>
            {initialEvents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="search">
          <Search />
          <input value={query} onChange={(eventChange) => setQuery(eventChange.target.value)} placeholder="Buscar participante" />
        </label>
        <div>
          <strong>{checkins}/{visible.length}</strong>
          <span>presentes {requiresPayment ? "· pagamento exigido" : "· sem cobrança"}</span>
        </div>
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      {visible.length ? (
        <div className="checkin-list">
          {visible.map((registration) => (
            <article key={registration.id}>
              <div>
                <strong>{participantName(registration.participants)}</strong>
                <span>{registration.attendance_confirmed ? "Presença confirmada" : "Aguardando chegada"}</span>
              </div>
              {requiresPayment && (
                <button
                  className={registration.payment_confirmed ? "done" : ""}
                  type="button"
                  disabled={loadingId === registration.id}
                  onClick={() => void toggle(registration, "payment_confirmed")}
                >
                  <CreditCard />
                  {registration.payment_confirmed ? "Pago" : "Confirmar pagamento"}
                </button>
              )}
              <button
                className={registration.attendance_confirmed ? "done" : ""}
                type="button"
                disabled={loadingId === registration.id}
                onClick={() => void toggle(registration, "attendance_confirmed")}
              >
                <UserCheck />
                {registration.attendance_confirmed ? "Check-in feito" : "Fazer check-in"}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state compact">
          <BadgeCheck />
          <h2>Nenhuma inscrição encontrada</h2>
          <p>{initialEvents.length ? "Selecione outro evento ou cadastre participantes." : "Crie um evento antes de fazer o credenciamento."}</p>
        </div>
      )}
    </section>
  );
}
