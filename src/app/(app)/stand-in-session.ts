import "server-only";
import { cookies } from "next/headers";
import type { Session } from "@/lib/auth";
import { ROLES, type Role } from "@/lib/enums";

// P1.6: DELETE THIS FILE. It stands in for getSession() until real sign-in
// exists, so the shell can be built and checked for every role.
//
// To view the app as another role, set the cookie in the browser console:
//   document.cookie = "eras_stand_in_role=FIELD_OFFICER; path=/"
// (ADMIN, COORDINATOR, FIELD_OFFICER or CENTER_MANAGER; default COORDINATOR).
// Names follow the seeded users (HANDOFF 4.8). The ids are placeholders:
// nothing reads them before P1.6.

const STAND_IN_COOKIE = "eras_stand_in_role";

const STAND_INS: Record<Role, Session> = {
  ADMIN: { userId: 0, name: "Ananya Iyer", role: "ADMIN", centerId: null },
  COORDINATOR: { userId: 0, name: "Rahul Menon", role: "COORDINATOR", centerId: null },
  FIELD_OFFICER: { userId: 0, name: "Kiran Kumar", role: "FIELD_OFFICER", centerId: null },
  CENTER_MANAGER: { userId: 0, name: "Suresh Gowda", role: "CENTER_MANAGER", centerId: 0 },
};

export async function getStandInSession(): Promise<Session> {
  const value = (await cookies()).get(STAND_IN_COOKIE)?.value;
  const role = ROLES.find((r) => r === value) ?? "COORDINATOR";
  return STAND_INS[role];
}
