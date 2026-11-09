import "server-only";
import type { Document } from "mongodb";

// Pipeline 2's core (docs/HANDOFF.md P2.4), shared by the dashboard's topNeeds
// and the analytics gap (P2.5).

const NEED_ITEM = { $trim: { input: "$needs_observed.item" } };
const NEED_UNIT = { $trim: { input: "$needs_observed.unit" } };

/** One need after grouping. unit is null when reporters gave none. */
export type NeedGroup = { item: string; unit: string | null; quantity: number; mentions: number };

/**
 * What reporters saw needed. Grouped by unit too: litres never add to packets.
 * Items and units are free text, so spellings that differ only in case or outer
 * spaces are one need. $min picks a stable label, and capitals sort first, so
 * the seed's "Drinking water" beats a typed "drinking water". The $cond keeps a
 * missing unit null: $toLower would turn it into "".
 */
export function groupNeedsStages(): Document[] {
  return [
    { $unwind: "$needs_observed" },
    {
      $group: {
        _id: {
          item: { $toLower: NEED_ITEM },
          unit: { $cond: [{ $ifNull: [NEED_UNIT, false] }, { $toLower: NEED_UNIT }, null] },
        },
        item: { $min: NEED_ITEM },
        unit: { $min: NEED_UNIT },
        quantity: { $sum: { $ifNull: ["$needs_observed.est_qty", 0] } },
        mentions: { $sum: 1 },
      },
    },
  ];
}
