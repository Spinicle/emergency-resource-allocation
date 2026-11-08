import { payloadSummary } from "@/components/activity-timeline";
import type { DashboardActivityEntry } from "@/lib/dashboard-types";

// The feed's wording. The switch has no fallback on purpose: a new entity type
// fails typecheck here until it's given a subject.

/** What an entry is about: "Request 12", "Batch MDK-GEN-01", "Field report 1043 (FLOOD)". */
export function feedSubject({ entity_type, entity_id, payload }: DashboardActivityEntry): string {
  switch (entity_type) {
    case "REQUEST":
      return `Request ${entity_id}`;
    case "ALLOCATION":
      return `Allocation ${entity_id}`;
    case "STOCK":
      return `Batch ${typeof payload?.batch_code === "string" ? payload.batch_code : entity_id}`;
    case "FIELD_REPORT":
      return typeof payload?.emergency_type === "string"
        ? `Field report ${entity_id} (${payload.emergency_type})`
        : `Field report ${entity_id}`;
    case "EMERGENCY":
      return `Emergency ${entity_id}`;
    case "IMPACT":
      return `Impact ${entity_id}`;
    default: {
      const unhandled: never = entity_type;
      return unhandled;
    }
  }
}

/** The text after the action. A STOCK subject already names the batch, so its summary doesn't repeat it. */
export function feedDetail(entry: DashboardActivityEntry): string {
  const summary = payloadSummary(entry.payload, { batch: entry.entity_type !== "STOCK" });
  return summary ? `${feedSubject(entry)} · ${summary}` : feedSubject(entry);
}
