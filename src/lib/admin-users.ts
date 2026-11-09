import "server-only";
import type { PoolConnection, ResultSetHeader } from "mysql2/promise";
import type { ActivityAction } from "@/lib/activity";
import type { AdminUserRow } from "@/lib/admin-types";
import { hashPassword, type Session } from "@/lib/auth";
import type { Role } from "@/lib/enums";
import { HttpError } from "@/lib/http";
import { logActivity } from "@/lib/mongo";
import { query, queryOne, withTransaction } from "@/lib/mysql";
import type { CreateUserInput, UpdateUserInput } from "@/lib/validators/admin";

// /api/admin/users (docs/HANDOFF.md P2.6). Users are never deleted. getSession()
// re-reads the user on every request, so a role, center or active change signs
// them out on their next one.

const ADMIN: Role = "ADMIN";

const USER_SQL = `
  SELECT u.user_id, u.name, u.email, r.role_name AS role, u.center_id, c.name AS center_name, u.is_active
    FROM \`user\` u
    JOIN role r                 ON r.role_id   = u.role_id
    LEFT JOIN resource_center c ON c.center_id = u.center_id`;

type UserDbRow = Omit<AdminUserRow, "is_active"> & { is_active: 0 | 1 };

const toUser = (row: UserDbRow): AdminUserRow => ({ ...row, is_active: row.is_active === 1 });

export async function listUsers(): Promise<AdminUserRow[]> {
  return (await query<UserDbRow>(`${USER_SQL} ORDER BY u.name, u.user_id`)).map(toUser);
}

async function loadUser(userId: number, conn: PoolConnection): Promise<AdminUserRow> {
  const row = await queryOne<UserDbRow>(`${USER_SQL} WHERE u.user_id = ?`, [userId], conn);
  if (!row) throw new HttpError(404, `User ${userId} not found`);
  return toUser(row);
}

/**
 * Starts every user change. The lock on the ADMIN role row makes these changes
 * run one at a time. The actor is then re-read under it: requireRole ran before
 * the lock, so two admins demoting each other could otherwise both pass and
 * leave no admin at all.
 */
async function lockAndCheckActor(conn: PoolConnection, session: Session): Promise<void> {
  await query("SELECT role_id FROM role WHERE role_name = ? FOR UPDATE", [ADMIN], conn);
  const actor = await queryOne<{ is_active: 0 | 1; role_name: Role }>(
    `SELECT u.is_active, r.role_name
       FROM \`user\` u JOIN role r ON r.role_id = u.role_id
      WHERE u.user_id = ?
        FOR UPDATE OF u`,
    [session.userId],
    conn,
  );
  if (!actor || actor.is_active !== 1 || actor.role_name !== ADMIN) throw new HttpError(403, "You don't have access to this");
}

export async function createUser(session: Session, input: CreateUserInput): Promise<AdminUserRow> {
  // Outside the transaction: bcrypt is slow and shouldn't hold the lock.
  const passwordHash = await hashPassword(input.password);
  const user = await withTransaction(async (conn) => {
    await lockAndCheckActor(conn, session);
    const [result] = await conn.query<ResultSetHeader>(
      `INSERT INTO \`user\` (role_id, name, email, password_hash, center_id)
       SELECT role_id, ?, ?, ?, ? FROM role WHERE role_name = ?`,
      [input.name, input.email, passwordHash, input.center_id ?? null, input.role],
    );
    return loadUser(result.insertId, conn);
  });
  await logActivity({
    actor: session,
    action: "USER_CREATED",
    entity: { type: "USER", id: user.user_id },
    payload: { name: user.name, role: user.role, center_id: user.center_id },
  });
  return user;
}

export async function updateUser(session: Session, userId: number, input: UpdateUserInput): Promise<AdminUserRow> {
  const { user, action } = await withTransaction(async (conn) => {
    await lockAndCheckActor(conn, session);
    const target = await queryOne<{ is_active: 0 | 1; role_name: Role }>(
      `SELECT u.is_active, r.role_name
         FROM \`user\` u JOIN role r ON r.role_id = u.role_id
        WHERE u.user_id = ?
          FOR UPDATE OF u`,
      [userId],
      conn,
    );
    if (!target) throw new HttpError(404, `User ${userId} not found`);
    if (userId === session.userId) {
      throw new HttpError(409, "You can't change your own role or deactivate your own account", { code: "RULE" });
    }

    const stillAdmin = input.is_active === undefined ? input.role === ADMIN : input.is_active;
    if (target.role_name === ADMIN && target.is_active === 1 && !stillAdmin) {
      // A backstop: the actor is an active admin other than the target, so this finds at least them.
      const others = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n
           FROM \`user\` u JOIN role r ON r.role_id = u.role_id
          WHERE r.role_name = ? AND u.is_active = TRUE AND u.user_id <> ?
            FOR SHARE OF u`,
        [ADMIN, userId],
        conn,
      );
      if (Number(others?.n ?? 0) === 0) throw new HttpError(409, "This is the last active admin", { code: "RULE" });
    }

    if (input.is_active === undefined) {
      await conn.query(
        "UPDATE `user` SET role_id = (SELECT role_id FROM role WHERE role_name = ?), center_id = ? WHERE user_id = ?",
        [input.role, input.center_id ?? null, userId],
      );
    } else {
      await conn.query("UPDATE `user` SET is_active = ? WHERE user_id = ?", [input.is_active, userId]);
    }
    const action: ActivityAction =
      input.is_active === undefined ? "USER_UPDATED" : input.is_active ? "USER_REACTIVATED" : "USER_DEACTIVATED";
    return { user: await loadUser(userId, conn), action };
  });
  await logActivity({
    actor: session,
    action,
    entity: { type: "USER", id: user.user_id },
    payload: { name: user.name, role: user.role, center_id: user.center_id },
  });
  return user;
}
