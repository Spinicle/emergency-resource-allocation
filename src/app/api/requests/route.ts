import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { fieldError, scopeParams } from "@/lib/emergencies";
import type { EmergencyStatus, ImpactStatus } from "@/lib/enums";
import { handle, HttpError, ok, parseJson, parseQuery } from "@/lib/http";
import { query, withTransaction } from "@/lib/mysql";
import { requireRole } from "@/lib/rbac";
import type { RequestCreated, RequestRow } from "@/lib/request-types";
import { logRequestEvent } from "@/lib/requests";
import { toBooleanQuery } from "@/lib/search";
import { createRequestSchema, requestListQuery } from "@/lib/validators/requests";

// /api/requests (docs/HANDOFF.md P2.2)
//   GET  ?emergency=&status=&urgency=&q=  -> RequestRow[]  (ADMIN, COORDINATOR, FIELD_OFFICER: their own)
//   POST                                  -> 201 RequestCreated  (FIELD_OFFICER, COORDINATOR)

const DEADLINE_MESSAGE = "The deadline has to be in the future";

const errnoOf = (err: unknown) => (err as { errno?: unknown } | null)?.errno;

type Impact = RowDataPacket & {
  emergency_id: number;
  impact_status: ImpactStatus;
  emergency_status: EmergencyStatus;
  deadline_passed: number;
};

export const GET = handle(async (req) => {
  const session = await requireRole("ADMIN", "COORDINATOR", "FIELD_OFFICER");
  const { emergency, status, urgency, q } = parseQuery(req, requestListQuery);

  // "" when there's no search. null when q held nothing searchable, as with
  // T17's `' OR 1=1 --`: nothing can match, so no query runs (lib/search.ts).
  const terms = q ? toBooleanQuery(q) : "";
  if (terms === null) return ok([]);

  const emergencyFilter = emergency ?? null;
  const statusFilter = status ?? null;
  const urgencyFilter = urgency ?? null;

  // One fixed statement: each optional filter is "(not set OR matches)", so no
  // SQL is assembled at runtime. The values are inlined as literals before
  // MySQL sees them, so the optimizer drops a filter that isn't set.
  //
  // The two subqueries run per request, so the work follows the rows returned
  // and joins can't multiply requests. FIELD() ranks urgency by severity (a
  // plain MAX would compare the words alphabetically, and LOW would beat HIGH);
  // ELT() turns the highest rank back into its word. The urgency filter is
  // EXISTS rather than a JOIN, so a request with two matching items shows once.
  const rows = await query<RequestRow>(
    `SELECT r.request_id, r.status, r.requested_at, r.required_by, r.description, r.impact_id,
            l.grid_id, e.emergency_id, e.name AS emergency_name, u.name AS requested_by,
            (SELECT COUNT(*) FROM request_item i WHERE i.request_id = r.request_id) AS item_count,
            (SELECT ELT(MAX(FIELD(i.urgency, 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')), 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
               FROM request_item i WHERE i.request_id = r.request_id) AS top_urgency
       FROM resource_request r
       JOIN emergency_impact ei ON ei.impact_id   = r.impact_id
       JOIN emergency e         ON e.emergency_id = ei.emergency_id
       JOIN location l          ON l.location_id  = ei.location_id
       JOIN \`user\` u          ON u.user_id      = r.user_id
      WHERE (? <> 'FIELD_OFFICER' OR r.user_id = ?)
        AND (? IS NULL OR ei.emergency_id = ?)
        AND (? IS NULL OR r.status = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM request_item f WHERE f.request_id = r.request_id AND f.urgency = ?))
        AND (? = '' OR MATCH(r.description) AGAINST (? IN BOOLEAN MODE))
      ORDER BY r.requested_at DESC, r.request_id DESC`,
    [
      ...scopeParams(session),
      emergencyFilter,
      emergencyFilter,
      statusFilter,
      statusFilter,
      urgencyFilter,
      urgencyFilter,
      terms,
      terms,
    ],
  );
  return ok(rows);
});

/*
 * The header and every item go in ONE transaction: if any item fails, the
 * rollback removes the header and the earlier items too. Statuses and
 * quantity_allocated are left to their defaults (OPEN, PENDING, 0), because the
 * triggers own them and refuse anything else.
 *
 * The first statement takes the impact and emergency FOR SHARE, so a concurrent
 * close or impact change waits for this commit and can't slip in between the
 * check and the insert. It can't deadlock with allocate or cancel: everything
 * after it touches only this transaction's own new rows, which nobody else can
 * see or wait on, plus shared foreign-key locks on the parents.
 */
export const POST = handle(async (req) => {
  const session = await requireRole("FIELD_OFFICER", "COORDINATOR");
  const { impact_id, required_by, description, items } = await parseJson(req, createRequestSchema);
  const deadline = required_by ?? null;

  const created = await withTransaction(async (conn) => {
    // MySQL's clock decides the deadline, as it does for requested_at below.
    const [impacts] = await conn.query<Impact[]>(
      `SELECT ei.emergency_id, ei.status AS impact_status, e.status AS emergency_status,
              (? IS NOT NULL AND ? <= NOW()) AS deadline_passed
         FROM emergency_impact ei
         JOIN emergency e ON e.emergency_id = ei.emergency_id
        WHERE ei.impact_id = ?
          FOR SHARE OF ei, e`,
      [deadline, deadline, impact_id],
    );
    const impact = impacts[0];
    if (!impact) throw new HttpError(404, `Impact ${impact_id} not found`);
    // A CLOSED emergency's items never reach the allocation queue, so a request here could never be served.
    if (impact.emergency_status === "CLOSED") {
      throw new HttpError(409, "This emergency is closed, so it takes no new requests", { code: "RULE" });
    }
    if (impact.impact_status === "RESOLVED") {
      throw new HttpError(409, "This location is resolved. A coordinator or admin must set it back to active first.", {
        code: "RULE",
      });
    }
    if (impact.deadline_passed) throw fieldError("required_by", DEADLINE_MESSAGE);

    let requestId: number;
    try {
      const [header] = await conn.query<ResultSetHeader>(
        "INSERT INTO resource_request (impact_id, user_id, required_by, description) VALUES (?, ?, ?, ?)",
        [impact_id, session.userId, deadline, description ?? null],
      );
      requestId = header.insertId;
    } catch (err) {
      // A lock wait above can carry requested_at past a deadline that was still
      // ahead when checked; chk_request_deadline is the final word.
      // The name decides: resource_request has another CHECK, on its status.
      if (errnoOf(err) === 3819 && String((err as { sqlMessage?: unknown }).sqlMessage).includes("chk_request_deadline")) {
        throw fieldError("required_by", DEADLINE_MESSAGE);
      }
      throw err;
    }

    // One at a time on purpose: one connection runs one statement at a time,
    // and the first failure must stop the rest and reach the rollback.
    for (const [index, item] of items.entries()) {
      try {
        await conn.query(
          "INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (?, ?, ?, ?)",
          [requestId, item.resource_id, item.quantity_requested, item.urgency],
        );
      } catch (err) {
        const field = `items.${index}.resource_id`;
        const errno = errnoOf(err);
        // uq_request_resource is the only unique key this INSERT can hit.
        if (errno === 1062) {
          const message = "Each resource can only appear once in a request";
          throw new HttpError(409, message, { code: "DUPLICATE", fields: { [field]: message } });
        }
        // The request was just inserted, so the missing parent can only be the
        // resource. era_app gets 1216; 1452 is what an admin connection would get.
        if (errno === 1216 || errno === 1452) {
          const message = "That resource no longer exists";
          throw new HttpError(409, message, { code: "MISSING_REFERENCE", fields: { [field]: message } });
        }
        throw err;
      }
    }
    return { request_id: requestId, emergency_id: impact.emergency_id };
  });

  await logRequestEvent(session, "REQUEST_CREATED", created.request_id, created.emergency_id);
  return ok({ request_id: created.request_id } satisfies RequestCreated, 201);
});
