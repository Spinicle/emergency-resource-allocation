import "server-only";
import { ACTIVITY_LOG } from "@db/mongo/activity_log";
import { FIELD_REPORTS } from "@db/mongo/field_reports";
import type { Db, Filter } from "mongodb";
import type { ActivityEntityType, ActivityEntry } from "@/lib/activity";
import type { Session } from "@/lib/auth";
import {
  ACTIVITY_FEED_LIMIT,
  type DashboardActivityEntry,
  type DashboardCenter,
  type DashboardData,
  type DashboardImpact,
  type DashboardKpis,
  LATEST_REPORTS_LIMIT,
  REPORT_WINDOW_DAYS,
  type ReportDayBucket,
  type ReportSummary,
  TOP_NEEDS_LIMIT,
  type TopNeed,
} from "@/lib/dashboard-types";
import { scopeParams, scopeSql } from "@/lib/emergencies";
import type { CenterStatus, EmergencyStatus, EmergencyType, Urgency } from "@/lib/enums";
import { dateToIst, istToDate } from "@/lib/ist";
import { getDb } from "@/lib/mongo";
import { query, queryOne } from "@/lib/mysql";
import { groupNeedsStages } from "@/lib/needs";
import type { Trend } from "@/lib/report-types";
import { type ListDoc, LIST_FIELDS, loadObservationInfo, toRow } from "@/lib/reports";
import { toTimelineEntry } from "@/lib/requests";
import { centerScope } from "@/lib/stock";
import { TRENDS } from "@/lib/validators/observations";

// GET /api/dashboard (docs/HANDOFF.md P2.4). The SQL and MongoDB halves run in
// parallel. An unreachable MongoDB fails the whole response: handle() turns it
// into the 503 every route gives (HANDOFF 4.6).

const IST_TIME_ZONE = "Asia/Kolkata";
const DAY_MS = 24 * 60 * 60 * 1000;

const ACTIVE: EmergencyStatus = "ACTIVE";
const EMERGENCY_CLOSED: EmergencyStatus = "CLOSED";
const CENTER_CLOSED: CenterStatus = "CLOSED";
const CRITICAL: Urgency = "CRITICAL";

// ---------------------------------------------------------------------------
// KPIs (MySQL)
// ---------------------------------------------------------------------------

type QueueCounts = { open_items: number; critical_items: number };

/**
 * The open and CRITICAL items, from the queue /allocate shows. A Center Manager
 * counts those their center has a usable batch for; a Field Officer their own.
 * The views have no user or request scope of their own, hence the joins.
 */
function loadQueueCounts(session: Session, center: number | null): Promise<QueueCounts | null> {
  if (center !== null) {
    return queryOne<QueueCounts>(
      `SELECT COUNT(DISTINCT b.request_item_id) AS open_items,
              COUNT(DISTINCT CASE WHEN q.urgency = ? AND q.quantity_remaining > 0 THEN b.request_item_id END) AS critical_items
         FROM v_batch_suggestions b
         JOIN v_priority_queue q ON q.request_item_id = b.request_item_id
        WHERE b.center_id = ?`,
      [CRITICAL, center],
    );
  }
  return queryOne<QueueCounts>(
    `SELECT COUNT(*) AS open_items,
            COUNT(CASE WHEN q.urgency = ? AND q.quantity_remaining > 0 THEN 1 END) AS critical_items
       FROM v_priority_queue q
       JOIN resource_request rr ON rr.request_id = q.request_id
      WHERE ${scopeSql("rr")}`,
    [CRITICAL, ...scopeParams(session)],
  );
}

/** Stock counts, for one center or (null) for all. CLOSED centers can't allocate or receive, so they don't count as out of stock. */
async function loadStockCounts(center: number | null): Promise<Pick<DashboardKpis, "expiring_batches" | "out_of_stock">> {
  const [expiring, out] = await Promise.all([
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM v_expiring_stock WHERE (? IS NULL OR center_id = ?)", [center, center]),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM v_stock_availability
        WHERE usable_quantity = 0 AND center_status <> ? AND (? IS NULL OR center_id = ?)`,
      [CENTER_CLOSED, center, center],
    ),
  ]);
  return { expiring_batches: Number(expiring?.n ?? 0), out_of_stock: Number(out?.n ?? 0) };
}

async function loadKpis(session: Session, center: number | null): Promise<DashboardKpis> {
  const [active, queue, stock] = await Promise.all([
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM emergency WHERE status = ?", [ACTIVE]),
    loadQueueCounts(session, center),
    // Field Officers get 403 on /api/stock, so they get no stock numbers here either.
    session.role === "FIELD_OFFICER" ? { expiring_batches: null, out_of_stock: null } : loadStockCounts(center),
  ]);
  return {
    active_emergencies: Number(active?.n ?? 0),
    open_items: Number(queue?.open_items ?? 0),
    critical_items: Number(queue?.critical_items ?? 0),
    ...stock,
  };
}

// ---------------------------------------------------------------------------
// Map (MySQL)
// ---------------------------------------------------------------------------

/**
 * Impacts of emergencies that aren't CLOSED, the same scope as the allocation
 * queue. ROW_NUMBER numbers each impact's observations newest first, so rn = 1
 * is the latest; the LEFT JOIN keeps impacts with no observation yet.
 */
function loadImpacts(): Promise<DashboardImpact[]> {
  return query<DashboardImpact>(
    `WITH ranked AS (
       SELECT o.impact_id, o.severity,
              ROW_NUMBER() OVER (PARTITION BY o.impact_id ORDER BY o.observed_at DESC) AS rn
         FROM impact_observation o
     )
     SELECT ei.impact_id, ei.status, l.grid_id, l.latitude, l.longitude,
            e.name AS emergency_name, r.severity AS latest_severity
       FROM emergency_impact ei
       JOIN emergency e   ON e.emergency_id = ei.emergency_id
       JOIN location l    ON l.location_id  = ei.location_id
       LEFT JOIN ranked r ON r.impact_id = ei.impact_id AND r.rn = 1
      WHERE e.status <> ?
      ORDER BY l.grid_id`,
    [EMERGENCY_CLOSED],
  );
}

function loadCenters(): Promise<DashboardCenter[]> {
  return query<DashboardCenter>(
    `SELECT c.center_id, c.name, c.center_type, c.status, l.latitude, l.longitude
       FROM resource_center c
       JOIN location l ON l.location_id = c.location_id
      ORDER BY c.name`,
  );
}

// ---------------------------------------------------------------------------
// Field report pipelines (MongoDB)
// ---------------------------------------------------------------------------

type ReportWindow = { from: Date; to: Date; days: string[] };

/**
 * The last REPORT_WINDOW_DAYS IST days, ending today. Fixed +05:30 arithmetic on
 * the instant (lib/ist.ts; IST has no daylight saving), never the process's own
 * time zone.
 */
function reportWindow(now: Date): ReportWindow {
  const today = dateToIst(now).slice(0, 10);
  const todayStart = istToDate(`${today} 00:00:00`).getTime();
  const fromMs = todayStart - (REPORT_WINDOW_DAYS - 1) * DAY_MS;
  return {
    from: new Date(fromMs),
    to: new Date(todayStart + DAY_MS),
    days: Array.from({ length: REPORT_WINDOW_DAYS }, (_, i) => dateToIst(new Date(fromMs + i * DAY_MS)).slice(0, 10)),
  };
}

const inWindow = ({ from, to }: ReportWindow) => ({ $match: { reported_at: { $gte: from, $lt: to } } });

/** Pipeline 1: reports per IST day and type. Days with none are filled in here. */
async function loadReportsByDay(db: Db, range: ReportWindow): Promise<ReportDayBucket[]> {
  const rows = await db
    .collection(FIELD_REPORTS)
    .aggregate<{ day: string; type: EmergencyType; count: number }>([
      inWindow(range),
      {
        $group: {
          _id: {
            day: { $dateTrunc: { date: "$reported_at", unit: "day", timezone: IST_TIME_ZONE } },
            type: "$emergency_type",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.day": 1, "_id.type": 1 } },
      {
        $project: {
          _id: 0,
          day: { $dateToString: { date: "$_id.day", format: "%Y-%m-%d", timezone: IST_TIME_ZONE } },
          type: "$_id.type",
          count: 1,
        },
      },
    ])
    .toArray();

  const buckets = new Map<string, ReportDayBucket>(range.days.map((day) => [day, { day, total: 0, counts: {} }]));
  for (const { day, type, count } of rows) {
    const bucket = buckets.get(day);
    if (!bucket) continue;
    bucket.total += count;
    bucket.counts[type] = count;
  }
  return [...buckets.values()];
}

/** Pipeline 2: what reporters saw needed in the window, biggest first. */
function loadTopNeeds(db: Db, range: ReportWindow): Promise<TopNeed[]> {
  return db
    .collection(FIELD_REPORTS)
    .aggregate<TopNeed>([
      inWindow(range),
      ...groupNeedsStages(),
      { $sort: { quantity: -1, "_id.item": 1, "_id.unit": 1 } },
      { $limit: TOP_NEEDS_LIMIT },
      { $project: { _id: 0, item: 1, unit: 1, quantity: 1 } },
    ])
    .toArray();
}

type SummaryFacet = {
  total: { n: number }[];
  byType: { _id: EmergencyType; count: number }[];
  byTrend: { _id: Trend | null; count: number }[];
  latest?: ListDoc[];
};

/** Pipeline 4: one $facet over every report. A Center Manager gets the counts but no reports. */
async function loadSummary(db: Db, includeLatest: boolean): Promise<ReportSummary> {
  const [facet] = await db
    .collection(FIELD_REPORTS)
    .aggregate<SummaryFacet>([
      {
        $facet: {
          total: [{ $count: "n" }],
          byType: [{ $group: { _id: "$emergency_type", count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }],
          // details.trend is optional, so a missing one groups as null.
          byTrend: [{ $group: { _id: { $ifNull: ["$details.trend", null] }, count: { $sum: 1 } } }],
          ...(includeLatest && {
            latest: [
              { $sort: { reported_at: -1, observation_id: -1 } },
              { $limit: LATEST_REPORTS_LIMIT },
              { $project: LIST_FIELDS },
            ],
          }),
        },
      },
    ])
    .toArray();

  const docs = facet?.latest ?? [];
  const info = await loadObservationInfo(docs.map((d) => d.observation_id));
  const trendCounts = new Map((facet?.byTrend ?? []).map((t) => [t._id, t.count]));
  return {
    total: facet?.total[0]?.n ?? 0,
    byType: (facet?.byType ?? []).map((t) => ({ type: t._id, count: t.count })),
    byTrend: [...TRENDS, null].map((trend) => ({ trend, count: trendCounts.get(trend) ?? 0 })),
    latest: docs.map((d) => toRow(d, info.get(d.observation_id))),
  };
}

// ---------------------------------------------------------------------------
// Activity feed (MongoDB)
// ---------------------------------------------------------------------------

/** Admin changes, as ADMIN-only as the /admin pages they come from. */
const ADMIN_ENTITY_TYPES: ActivityEntityType[] = ["USER", "RESOURCE", "CENTER", "LOCATION"];

/**
 * Whose entries this session sees. The sort walks an index ending in ts: -1, so
 * the feed needs no in-memory sort: a Field Officer's $or is a SORT_MERGE of two.
 */
async function feedFilter(session: Session, center: number | null): Promise<Filter<ActivityEntry>> {
  if (center !== null) return { "refs.center_id": center };
  if (session.role === "COORDINATOR") return { "entity.type": { $nin: ADMIN_ENTITY_TYPES } };
  if (session.role !== "FIELD_OFFICER") return {};

  const own = await query<{ request_id: number }>("SELECT request_id FROM resource_request WHERE user_id = ?", [session.userId]);
  const mine = { "actor.user_id": session.userId };
  return own.length === 0 ? mine : { $or: [mine, { "refs.request_id": { $in: own.map((r) => r.request_id) } }] };
}

async function loadRecentActivity(db: Db, session: Session, center: number | null): Promise<DashboardActivityEntry[]> {
  const filter = await feedFilter(session, center);
  const entries = await db.collection<ActivityEntry>(ACTIVITY_LOG).find(filter).sort({ ts: -1 }).limit(ACTIVITY_FEED_LIMIT).toArray();
  return entries.map((e) => ({
    ...toTimelineEntry(e),
    actor_user_id: e.actor.user_id,
    entity_type: e.entity.type,
    refs: e.refs ?? null,
  }));
}

// ---------------------------------------------------------------------------
// The whole response
// ---------------------------------------------------------------------------

async function loadMongoParts(session: Session, center: number | null) {
  const db = await getDb();
  const range = reportWindow(new Date());
  const [reportsByDay, topNeeds, summary, recentActivity] = await Promise.all([
    loadReportsByDay(db, range),
    loadTopNeeds(db, range),
    loadSummary(db, session.role !== "CENTER_MANAGER"),
    loadRecentActivity(db, session, center),
  ]);
  return { reportsByDay, topNeeds, summary, recentActivity };
}

export async function loadDashboard(session: Session): Promise<DashboardData> {
  // centerScope refuses a Center Manager without a center, so null only ever means "not a Center Manager".
  const center = session.role === "CENTER_MANAGER" ? centerScope(session, undefined) : null;
  const [kpis, impacts, centers, mongo] = await Promise.all([
    loadKpis(session, center),
    loadImpacts(),
    loadCenters(),
    loadMongoParts(session, center),
  ]);
  return { role: session.role, kpis, impacts, centers, ...mongo };
}
