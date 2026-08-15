import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CheckinManager from "./checkin-manager";

export const dynamic = "force-dynamic";

export default async function CheckinPage() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/entrar");

  const [{ data: roles }, { data: eventMemberships }] = await Promise.all([
    supabase
      .from("user_roles")
      .select("organization_id,role")
      .eq("user_id", userId)
      .in("role", ["admin", "organizer"])
      .limit(1),
    supabase
      .from("event_users")
      .select("event_id")
      .eq("user_id", userId)
      .eq("role", "organizer"),
  ]);
  const managerRole = roles?.[0];
  const assignedEventIds = [...new Set((eventMemberships || []).map((membership) => membership.event_id))];
  if (!managerRole && !assignedEventIds.length) redirect("/painel");

  let eventsQuery = supabase
    .from("events")
    .select("id,name,settings")
    .neq("status", "archived")
    .order("created_at", { ascending: false });
  eventsQuery = managerRole
    ? eventsQuery.eq("organization_id", managerRole.organization_id)
    : eventsQuery.in("id", assignedEventIds);
  const { data: events } = await eventsQuery;
  const eventIds = (events || []).map((event) => event.id);
  const registrationsResult = eventIds.length
    ? await supabase
      .from("registrations")
      .select("id,event_id,attendance_confirmed,payment_confirmed,participants(full_name)")
      .in("event_id", eventIds)
    : { data: [], error: null };

  return (
    <main className="management-page">
      <Link href="/participantes" className="back-link">← Voltar para participantes</Link>
      <div className="management-top">
        <div>
          <span className="eyebrow">OPERAÇÃO</span>
          <h1>Credenciamento</h1>
          <p>Confirme a presença; pagamento só aparece quando o evento o exigir.</p>
        </div>
      </div>
      <CheckinManager
        initialEvents={events || []}
        initialRegistrations={registrationsResult.data || []}
        initialError={registrationsResult.error?.message || ""}
      />
    </main>
  );
}
