/**
 * Section 3, the role matrix: every route signed out and as each role. An
 * allowed role proves it got past the role check without writing (a bad body
 * -> 400, an unknown id -> 404); a refused role sends a valid request and gets
 * 403. Part 2 adds its routes to endpoints().
 */
import { ROLES, type Role } from "../../src/lib/enums";
import type { Ctx, Ids } from "./context";
import { check, FORBIDDEN, isError, MAX_ID, type Reply, type Req, section, send, show, SIGNED_OUT } from "./harness";

type Endpoint = {
  label: string;
  allowed: readonly Role[];
  /** For an allowed role: must write nothing. */
  probe: Req;
  status: number;
  code?: string;
  verify?: (r: Reply, role: Role) => boolean;
  /** For refused roles and signed out: a valid request. Defaults to probe. */
  refused?: Req;
  tag?: Partial<Record<Role, string>>;
};

function endpoints(ids: Ids): Endpoint[] {
  const ALL = ROLES;
  const AC: Role[] = ["ADMIN", "COORDINATOR"];
  const AM: Role[] = ["ADMIN", "CENTER_MANAGER"];
  const G = (path: string): Req => ({ method: "GET", path });
  const P = (path: string, body?: unknown): Req => ({ method: "POST", path, body });
  const adjustBody = { delta: 1, reason: "ADJUSTMENT" };
  return [
    { label: "GET /api/auth/me", allowed: ALL, probe: G("/api/auth/me"), status: 200, verify: (r, role) => r.body?.data?.role === role },
    {
      label: "POST /api/observations",
      allowed: ["ADMIN", "COORDINATOR", "FIELD_OFFICER"],
      probe: P("/api/observations", {}),
      status: 400,
      code: "VALIDATION",
      refused: P("/api/observations", {
        impact_id: ids.bellandur,
        emergency_type: "FLOOD",
        affected_percentage: 10,
        severity: "LOW",
        details: { water_level_m: 1, roads_submerged: 0 },
      }),
    },
    { label: "GET /api/allocations/queue", allowed: AC, probe: G("/api/allocations/queue"), status: 200 },
    { label: "GET /api/allocations/suggestions", allowed: AC, probe: G(`/api/allocations/suggestions?item=${ids.jackets}`), status: 200 },
    {
      label: "GET /api/allocations?item=",
      allowed: AC,
      probe: G(`/api/allocations?item=${MAX_ID}`),
      status: 404,
      code: "NOT_FOUND",
      refused: G(`/api/allocations?item=${ids.jackets}`),
    },
    {
      label: "POST /api/allocations",
      allowed: AC,
      probe: P("/api/allocations", { request_item_id: ids.meals, batches: [] }),
      status: 400,
      code: "VALIDATION",
      refused: P("/api/allocations", { request_item_id: ids.meals, batches: [{ stock_id: ids.rte01, quantity: 1 }] }),
      tag: { FIELD_OFFICER: "T14" },
    },
    {
      // An unknown id is the procedure's 409 by contract (4.9), so the probe is a bad id.
      label: "POST /api/allocations/[id]/cancel",
      allowed: AC,
      probe: P("/api/allocations/0/cancel"),
      status: 400,
      code: "VALIDATION",
      refused: P(`/api/allocations/${ids.genAlloc}/cancel`),
    },
    { label: "GET /api/resources", allowed: ALL, probe: G("/api/resources"), status: 200 },
    { label: "GET /api/stock", allowed: AM, probe: G("/api/stock"), status: 200 },
    {
      label: "POST /api/stock",
      allowed: AM,
      probe: P("/api/stock", {}),
      status: 400,
      code: "VALIDATION",
      refused: P("/api/stock", { resource_id: ids.water, center_id: ids.blr, batch_code: "zz_api_refused", quantity: 1 }),
    },
    {
      label: "POST /api/stock/[id]/adjust",
      allowed: AM,
      probe: P(`/api/stock/${MAX_ID}/adjust`, adjustBody),
      status: 404,
      code: "NOT_FOUND",
      refused: P(`/api/stock/${ids.rice}/adjust`, adjustBody),
    },
    {
      label: "GET /api/stock/[id]/ledger",
      allowed: AM,
      probe: G(`/api/stock/${MAX_ID}/ledger`),
      status: 404,
      code: "NOT_FOUND",
      refused: G(`/api/stock/${ids.rice}/ledger`),
    },
    { label: "GET /api/stock/allocations", allowed: AM, probe: G("/api/stock/allocations"), status: 200 },
    {
      label: "POST /api/stock/allocations/[id]/dispatch",
      allowed: AM,
      probe: P(`/api/stock/allocations/${MAX_ID}/dispatch`),
      status: 404,
      code: "NOT_FOUND",
      refused: P(`/api/stock/allocations/${ids.genAlloc}/dispatch`),
    },
    {
      label: "POST /api/stock/allocations/[id]/deliver",
      allowed: AM,
      probe: P(`/api/stock/allocations/${MAX_ID}/deliver`),
      status: 404,
      code: "NOT_FOUND",
      refused: P(`/api/stock/allocations/${ids.ljAlloc}/deliver`),
    },
    { label: "GET /api/zz-no-such-route", allowed: ALL, probe: G("/api/zz-no-such-route"), status: 404, code: "NOT_FOUND" },
    { label: "GET /api", allowed: ALL, probe: G("/api"), status: 404, code: "NOT_FOUND" },
  ];
}

export async function checkMatrix(c: Ctx): Promise<void> {
  const list = endpoints(c.ids);
  section(`3. Role matrix (${list.length} endpoints x signed out + ${ROLES.length} roles)`);
  for (const e of list) {
    const out = await send(e.refused ?? e.probe, null);
    check(`${e.label} signed out -> 401`, isError(out, 401, "UNAUTHENTICATED", SIGNED_OUT), show(out));
    for (const role of ROLES) {
      const tag = e.tag?.[role] ? ` (${e.tag[role]})` : "";
      if (e.allowed.includes(role)) {
        const r = await send(e.probe, c.as[role]);
        check(`${e.label} as ${role} -> ${e.status}${tag}`, isError(r, e.status, e.code) && (!e.verify || e.verify(r, role)), show(r));
      } else {
        const r = await send(e.refused ?? e.probe, c.as[role]);
        check(`${e.label} as ${role} -> 403${tag}`, isError(r, 403, "FORBIDDEN", FORBIDDEN), show(r));
      }
    }
  }
}
