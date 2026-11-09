import "server-only";
import { FIELD_REPORTS } from "@db/mongo/field_reports";
import type { EscalatingRow, FulfilmentRow, GapData, GapRow, GapStatus, UnmetRow } from "@/lib/analytics-types";
import { HttpError } from "@/lib/http";
import { getDb } from "@/lib/mongo";
import { query, queryOne } from "@/lib/mysql";
import { groupNeedsStages, type NeedGroup } from "@/lib/needs";

// /api/analytics/* (docs/HANDOFF.md P2.5). Only the gap reads MongoDB, so an
// unreachable MongoDB fails that route alone (handle() turns it into the 503).

export function loadUnmet(emergencyId: number | undefined): Promise<UnmetRow[]> {
  const id = emergencyId ?? null;
  return query<UnmetRow>(
    `SELECT emergency_id, emergency_name, emergency_status, resource_id, resource_name, category, unit,
            item_count, quantity_requested, quantity_allocated, quantity_unmet
       FROM v_unmet_demand
      WHERE (? IS NULL OR emergency_id = ?)
      ORDER BY quantity_unmet DESC, emergency_name, resource_name`,
    [id, id],
  );
}

export function loadFulfilment(): Promise<FulfilmentRow[]> {
  return query<FulfilmentRow>(
    `SELECT emergency_id, emergency_name, emergency_type, emergency_status,
            items_total, items_fulfilled, items_partial, items_pending, item_rate_pct, quantity_rate_pct
       FROM v_fulfilment_rate
      ORDER BY emergency_name, emergency_id`,
  );
}

export function loadEscalating(): Promise<EscalatingRow[]> {
  return query<EscalatingRow>(
    `SELECT emergency_id, emergency, emergency_status, impact_id, impact_status, grid_id,
            severity, prev_severity, sev_rank, prev_rank, observed_at
       FROM v_escalating_impacts
      ORDER BY sev_rank DESC, observed_at DESC, impact_id`,
  );
}

type CatalogueRow = { name: string; unit: string };

const normal = (text: string) => text.trim().toLowerCase();

/** What a resource's reports add up to, in its own unit. */
type Observed = { item: string; quantity: number; mentions: number };

/**
 * Splits the grouped needs into those comparable with a resource (same name and
 * unit, or no unit given) and those that aren't: free text naming no resource,
 * or a unit the resource isn't measured in.
 */
function matchNeeds(needs: NeedGroup[], catalogue: CatalogueRow[], requested: Set<string>) {
  const units = new Map(catalogue.map((c) => [normal(c.name), { name: c.name, unit: c.unit }]));
  const observed = new Map<string, Observed>();
  const unmatched = new Map<string, GapRow>();

  for (const need of needs) {
    const key = normal(need.item);
    const resource = units.get(key);
    if (resource && (need.unit === null || normal(need.unit) === normal(resource.unit))) {
      const entry = observed.get(key) ?? { item: resource.name, quantity: 0, mentions: 0 };
      entry.quantity += need.quantity;
      entry.mentions += need.mentions;
      observed.set(key, entry);
      continue;
    }

    // MongoDB's $toLower only folds ASCII, so "ÉCLAIR" and "éclair" reach here as
    // two groups. They're one need, and a row's key must stay unique.
    const rowKey = `other:${key}:${need.unit === null ? "" : normal(need.unit)}`;
    const existing = unmatched.get(rowKey);
    if (existing) {
      existing.observed_quantity = (existing.observed_quantity ?? 0) + need.quantity;
      existing.mentions += need.mentions;
    } else {
      unmatched.set(rowKey, {
        key: rowKey,
        item: need.item,
        unit: need.unit,
        status: requested.has(key) ? "DIFFERENT_UNIT" : "OBSERVED_ONLY",
        in_catalogue: resource !== undefined,
        unit_differs: resource !== undefined,
        observed_quantity: need.quantity,
        mentions: need.mentions,
        quantity_requested: null,
        quantity_allocated: null,
        quantity_unmet: null,
      });
    }
  }
  return { observed, unmatched: [...unmatched.values()], units };
}

/** Observed-only first; rows with no requested figures by mentions, the rest by what's still unmet. */
function compareGapRows(a: GapRow, b: GapRow): number {
  const rank: Record<GapStatus, number> = { OBSERVED_ONLY: 0, BOTH: 1, DIFFERENT_UNIT: 2, REQUESTED_ONLY: 3 };
  return (
    rank[a.status] - rank[b.status] ||
    (a.quantity_unmet === null ? b.mentions - a.mentions : (b.quantity_unmet ?? 0) - a.quantity_unmet) ||
    a.item.localeCompare(b.item)
  );
}

/**
 * Pipeline 2 over all of this emergency's reports, beside its v_unmet_demand
 * rows. All of them, not the dashboard's 14 days: the unmet side is all-time,
 * and a closed emergency's reports would otherwise drop out.
 */
export async function loadGap(emergencyId: number): Promise<GapData> {
  const emergency = await queryOne<GapData["emergency"]>(
    "SELECT emergency_id, name, type, status FROM emergency WHERE emergency_id = ?",
    [emergencyId],
  );
  if (!emergency) throw new HttpError(404, `Emergency ${emergencyId} not found`);

  const [requested, catalogue, db] = await Promise.all([
    loadUnmet(emergencyId),
    query<CatalogueRow>("SELECT name, unit FROM resource"),
    getDb(),
  ]);
  const needs = await db
    .collection(FIELD_REPORTS)
    .aggregate<NeedGroup>([
      { $match: { emergency_id: emergencyId } },
      ...groupNeedsStages(),
      { $project: { _id: 0, item: 1, unit: 1, quantity: 1, mentions: 1 } },
    ])
    .toArray();

  const requestedNames = new Set(requested.map((r) => normal(r.resource_name)));
  const { observed, unmatched, units } = matchNeeds(needs, catalogue, requestedNames);

  const rows: GapRow[] = [...unmatched];
  for (const r of requested) {
    const key = normal(r.resource_name);
    const seen = observed.get(key);
    observed.delete(key);
    rows.push({
      key: `resource:${key}`,
      item: r.resource_name,
      unit: r.unit,
      status: seen ? "BOTH" : "REQUESTED_ONLY",
      in_catalogue: true,
      unit_differs: false,
      observed_quantity: seen?.quantity ?? null,
      mentions: seen?.mentions ?? 0,
      quantity_requested: r.quantity_requested,
      quantity_allocated: r.quantity_allocated,
      quantity_unmet: r.quantity_unmet,
    });
  }
  // What's left was seen in reports but nobody is asking for it.
  for (const [key, seen] of observed) {
    rows.push({
      key: `resource:${key}`,
      item: seen.item,
      unit: units.get(key)?.unit ?? null,
      status: "OBSERVED_ONLY",
      in_catalogue: true,
      unit_differs: false,
      observed_quantity: seen.quantity,
      mentions: seen.mentions,
      quantity_requested: null,
      quantity_allocated: null,
      quantity_unmet: null,
    });
  }

  rows.sort(compareGapRows);
  const counts: Record<GapStatus, number> = { OBSERVED_ONLY: 0, BOTH: 0, DIFFERENT_UNIT: 0, REQUESTED_ONLY: 0 };
  for (const row of rows) counts[row.status] += 1;
  return { emergency, rows, counts };
}
