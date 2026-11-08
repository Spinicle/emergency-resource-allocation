import "server-only";
import { FIELD_REPORTS } from "@db/mongo/field_reports";
import type { Collection } from "mongodb";
import type { EmergencyType } from "@/lib/enums";
import { HttpError } from "@/lib/http";
import { dateToIst } from "@/lib/ist";
import { getDb } from "@/lib/mongo";
import { query } from "@/lib/mysql";
import {
  REPORT_LIST_CAP,
  type ReportCasualties,
  type ReportDetail,
  type ReportInfrastructure,
  type ReportList,
  type ReportNeed,
  type ReportRow,
} from "@/lib/report-types";
import { DEFAULT_NEAR_KM, type ReportListQuery } from "@/lib/validators/reports";

// The read side of field_reports, for /api/reports/* (docs/HANDOFF.md P2.3).
// MongoDB can't run $geoNear and $text in one pipeline, so there are three
// separate paths. MongoDB holds no names or severities: those come from one
// MySQL query per page of rows. An unreachable MongoDB isn't caught here;
// handle() turns it into a 503.

type ReportDoc = {
  observation_id: number;
  emergency_id: number;
  impact_id: number;
  emergency_type: EmergencyType;
  reported_by: { user_id: number; name: string };
  reported_at: Date;
  location: { type: "Point"; coordinates: [number, number] };
  details: Record<string, unknown>;
  casualties?: ReportCasualties;
  needs_observed?: ReportNeed[];
  infrastructure?: ReportInfrastructure[];
  notes?: string;
  tags?: string[];
  photos?: string[];
};

/** What a list row needs from a document. */
type ListDoc = Pick<
  ReportDoc,
  "observation_id" | "emergency_id" | "impact_id" | "emergency_type" | "reported_by" | "reported_at" | "location" | "details"
> & { distance_m?: number };

const LIST_FIELDS = {
  _id: 0,
  observation_id: 1,
  emergency_id: 1,
  impact_id: 1,
  emergency_type: 1,
  reported_by: 1,
  reported_at: 1,
  location: 1,
  "details.trend": 1,
} as const;

type Found = { docs: ListDoc[]; total: number };
type Filters = Partial<Pick<ReportDoc, "emergency_id" | "emergency_type">>;

/** Newest first. The emergency filter uses { emergency_id: 1, reported_at: -1 }. */
async function findPlain(reports: Collection<ReportDoc>, filters: Filters): Promise<Found> {
  const [docs, total] = await Promise.all([
    reports.find(filters, { projection: LIST_FIELDS }).sort({ reported_at: -1 }).limit(REPORT_LIST_CAP).toArray(),
    reports.countDocuments(filters),
  ]);
  return { docs: docs as unknown as ListDoc[], total };
}

/** Nearest first. $geoNear must come first; the filters go in its query. A $facet gives the total in one pass. */
async function findNear(
  reports: Collection<ReportDoc>,
  filters: Filters,
  near: { lat: number; lng: number },
  km: number,
): Promise<Found> {
  const [result] = await reports
    .aggregate<{ docs: ListDoc[]; count: { n: number }[] }>([
      {
        $geoNear: {
          // GeoJSON order is [lng, lat] (HANDOFF 8).
          near: { type: "Point", coordinates: [near.lng, near.lat] },
          key: "location",
          spherical: true,
          distanceField: "distance_m",
          maxDistance: km * 1000,
          query: filters,
        },
      },
      { $project: { ...LIST_FIELDS, distance_m: 1 } },
      { $facet: { docs: [{ $limit: REPORT_LIST_CAP }], count: [{ $count: "n" }] } },
    ])
    .toArray();
  return { docs: result?.docs ?? [], total: result?.count[0]?.n ?? 0 };
}

/** Best match first, newest among equals. q reaches $search only as a plain string. */
async function findText(reports: Collection<ReportDoc>, filters: Filters, q: string): Promise<Found> {
  const match = { $text: { $search: q }, ...filters };
  const [docs, total] = await Promise.all([
    reports
      .aggregate<ListDoc>([
        { $match: match },
        { $sort: { score: { $meta: "textScore" }, reported_at: -1 } },
        { $limit: REPORT_LIST_CAP },
        { $project: LIST_FIELDS },
      ])
      .toArray(),
    reports.countDocuments(match),
  ]);
  return { docs, total };
}

/** The MySQL side of a report. */
type ObservationInfo = Pick<
  ReportRow,
  "observation_id" | "severity" | "affected_percentage" | "observed_at" | "grid_id" | "emergency_name" | "emergency_status" | "reporter"
>;

/** One query for a whole page of reports. */
async function loadObservationInfo(ids: number[]): Promise<Map<number, ObservationInfo>> {
  if (ids.length === 0) return new Map(); // IN () is a syntax error
  const rows = await query<ObservationInfo>(
    `SELECT o.observation_id, o.severity, o.affected_percentage, o.observed_at,
            l.grid_id, e.name AS emergency_name, e.status AS emergency_status, u.name AS reporter
       FROM impact_observation o
       JOIN emergency_impact ei ON ei.impact_id   = o.impact_id
       JOIN location l          ON l.location_id  = ei.location_id
       JOIN emergency e         ON e.emergency_id = ei.emergency_id
       JOIN \`user\` u          ON u.user_id      = o.user_id
      WHERE o.observation_id IN (?)`,
    [ids],
  );
  return new Map(rows.map((r) => [r.observation_id, r]));
}

function toRow(doc: ListDoc, info: ObservationInfo | undefined): ReportRow {
  const [longitude, latitude] = doc.location.coordinates;
  const trend = doc.details.trend;
  return {
    observation_id: doc.observation_id,
    emergency_id: doc.emergency_id,
    impact_id: doc.impact_id,
    emergency_type: doc.emergency_type,
    // MongoDB holds a UTC instant; the pages show every time as IST wall clock.
    reported_at: dateToIst(doc.reported_at),
    latitude,
    longitude,
    trend: trend === "RISING" || trend === "STEADY" || trend === "FALLING" ? trend : null,
    reporter: info?.reporter ?? doc.reported_by.name,
    distance_m: doc.distance_m === undefined ? null : Math.round(doc.distance_m),
    severity: info?.severity ?? null,
    affected_percentage: info?.affected_percentage ?? null,
    observed_at: info?.observed_at ?? null,
    grid_id: info?.grid_id ?? null,
    emergency_name: info?.emergency_name ?? null,
    emergency_status: info?.emergency_status ?? null,
  };
}

/** GET /api/reports. */
export async function listReports({ emergency, type, q, near, km }: ReportListQuery): Promise<ReportList> {
  const reports = (await getDb()).collection<ReportDoc>(FIELD_REPORTS);
  const filters: Filters = {
    ...(emergency !== undefined && { emergency_id: emergency }),
    ...(type !== undefined && { emergency_type: type }),
  };

  const { docs, total } = near
    ? await findNear(reports, filters, near, km ?? DEFAULT_NEAR_KM)
    : q
      ? await findText(reports, filters, q)
      : await findPlain(reports, filters);

  const info = await loadObservationInfo(docs.map((d) => d.observation_id));
  return {
    reports: docs.map((d) => toRow(d, info.get(d.observation_id))),
    total,
    capped: total > docs.length,
  };
}

/** GET /api/reports/[id]: the document plus its MySQL row. */
export async function loadReport(observationId: number): Promise<ReportDetail> {
  const reports = (await getDb()).collection<ReportDoc>(FIELD_REPORTS);
  const doc = await reports.findOne({ observation_id: observationId }, { projection: { _id: 0 } });
  if (!doc) throw new HttpError(404, `Report ${observationId} not found`);

  const info = await loadObservationInfo([observationId]);
  return {
    ...toRow(doc, info.get(observationId)),
    details: doc.details,
    casualties: doc.casualties ?? null,
    needs_observed: doc.needs_observed ?? [],
    infrastructure: doc.infrastructure ?? [],
    notes: doc.notes ?? null,
    tags: doc.tags ?? [],
    photos: doc.photos ?? [],
  };
}
