"use client";

import { Pencil, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { InlineError, ToneBadge } from "@/app/(app)/allocate/bits";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ROLE_LABELS } from "@/config/nav";
import type { AdminCenterRow, AdminUserRow } from "@/lib/admin-types";
import type { FieldErrors } from "@/lib/api-contract";
import { api, useApi } from "@/lib/client";
import { ROLES, type Role } from "@/lib/enums";
import type { CreateUserInput, UpdateUserInput } from "@/lib/validators/admin";
import { ConfirmAction } from "../confirm-action";
import { FormDialog, type ReadField } from "@/components/form-dialog";

// /admin/users: create, change role or center, deactivate and reactivate. Users
// are never deleted. Admins don't get these controls on their own row.

const CENTER_MANAGER: Role = "CENTER_MANAGER";

/** The role, and a center only when the role needs one. */
function AssignmentFields({
  fields,
  centers,
  defaultRole,
  defaultCenter,
}: {
  fields: FieldErrors;
  centers: AdminCenterRow[];
  defaultRole: Role;
  defaultCenter?: number | null;
}) {
  const [role, setRole] = useState<Role>(defaultRole);
  return (
    <>
      <FormField htmlFor="role" label="Role" error={fields.role}>
        <Select name="role" value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger id="role" aria-invalid={!!fields.role} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {role === CENTER_MANAGER && (
        <FormField htmlFor="center_id" label="Center" error={fields.center_id}>
          <Select name="center_id" defaultValue={defaultCenter ? String(defaultCenter) : undefined}>
            <SelectTrigger id="center_id" aria-invalid={!!fields.center_id} className="w-full">
              <SelectValue placeholder="Choose a center" />
            </SelectTrigger>
            <SelectContent>
              {centers.map((c) => (
                <SelectItem key={c.center_id} value={String(c.center_id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}
    </>
  );
}

/** The center for a role: an id for a Center Manager (undefined if none was picked, which the API refuses), else none. */
function centerFor(role: Role, read: ReadField): number | null | undefined {
  if (role !== CENTER_MANAGER) return null;
  const value = read("center_id");
  return value ? Number(value) : undefined;
}

function NewUserDialog({ centers, onDone }: { centers: AdminCenterRow[]; onDone: () => void }) {
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <Plus />
          New user
        </Button>
      }
      title="New user"
      description="A center manager needs a center. Nobody else has one."
      savedMessage="User created"
      onDone={onDone}
      submit={async (read) => {
        const role = read("role") as Role;
        const body: Partial<CreateUserInput> = {
          name: read("name"),
          email: read("email"),
          password: read("password"),
          role,
          center_id: centerFor(role, read),
        };
        await api("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
      }}
    >
      {(fields) => (
        <>
          <FormField htmlFor="name" label="Name" error={fields.name}>
            <Input id="name" name="name" aria-invalid={!!fields.name} autoFocus />
          </FormField>
          <FormField htmlFor="email" label="Email" error={fields.email}>
            <Input id="email" name="email" type="email" aria-invalid={!!fields.email} />
          </FormField>
          <FormField htmlFor="password" label="Password (at least 8 characters)" error={fields.password}>
            <Input id="password" name="password" type="password" autoComplete="new-password" aria-invalid={!!fields.password} />
          </FormField>
          <AssignmentFields fields={fields} centers={centers} defaultRole="FIELD_OFFICER" />
        </>
      )}
    </FormDialog>
  );
}

function EditAssignmentDialog({ user, centers, onDone }: { user: AdminUserRow; centers: AdminCenterRow[]; onDone: () => void }) {
  return (
    <FormDialog
      trigger={
        <Button variant="outline" size="sm">
          <Pencil />
          Role
        </Button>
      }
      title={`Change ${user.name}'s role`}
      description="This signs them out on their next request."
      savedMessage={`${user.name} updated. They'll be signed out on their next request.`}
      onDone={onDone}
      submit={async (read) => {
        const role = read("role") as Role;
        const center = centerFor(role, read);
        if (role === user.role && center === user.center_id) return false;
        const body: UpdateUserInput = { role, center_id: center };
        await api(`/api/admin/users/${user.user_id}`, { method: "PATCH", body: JSON.stringify(body) });
      }}
    >
      {(fields) => <AssignmentFields fields={fields} centers={centers} defaultRole={user.role} defaultCenter={user.center_id} />}
    </FormDialog>
  );
}

const col = dataTableColumns<AdminUserRow>();

function columns(currentUserId: number | null, centers: AdminCenterRow[], onDone: () => void) {
  return col.columns([
    col.accessor("name", {
      header: ({ column }) => <SortableHeader column={column} title="Name" />,
      cell: ({ getValue, row }) => (
        <span className="flex items-center gap-2 font-medium">
          {getValue()}
          {row.original.user_id === currentUserId && <ToneBadge tone="blue">You</ToneBadge>}
        </span>
      ),
    }),
    col.accessor("email", { header: ({ column }) => <SortableHeader column={column} title="Email" /> }),
    col.accessor("role", {
      header: ({ column }) => <SortableHeader column={column} title="Role" />,
      cell: ({ getValue }) => ROLE_LABELS[getValue()],
    }),
    col.accessor("center_name", {
      header: ({ column }) => <SortableHeader column={column} title="Center" />,
      cell: ({ getValue }) => getValue() ?? "—",
    }),
    col.accessor("is_active", {
      header: "Status",
      cell: ({ getValue }) => (getValue() ? <ToneBadge tone="green">Active</ToneBadge> : <ToneBadge tone="grey">Deactivated</ToneBadge>),
    }),
    col.display({
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const user = row.original;
        if (user.user_id === currentUserId) return null;
        const setActive = (is_active: boolean) => api(`/api/admin/users/${user.user_id}`, { method: "PATCH", body: JSON.stringify({ is_active }) });
        return (
          <div className="flex justify-end gap-2">
            <EditAssignmentDialog user={user} centers={centers} onDone={onDone} />
            {user.is_active ? (
              <ConfirmAction
                label="Deactivate"
                title={`Deactivate ${user.name}?`}
                description="They're signed out on their next request and can't sign in until reactivated. Their history stays."
                actionLabel="Deactivate"
                doneMessage={`${user.name} deactivated`}
                run={() => setActive(false)}
                onDone={onDone}
              />
            ) : (
              <ConfirmAction
                label="Reactivate"
                title={`Reactivate ${user.name}?`}
                description="They'll be able to sign in again with their existing password."
                actionLabel="Reactivate"
                doneMessage={`${user.name} reactivated`}
                destructive={false}
                run={() => setActive(true)}
                onDone={onDone}
              />
            )}
          </div>
        );
      },
    }),
  ]);
}

export function UsersView({ currentUserId }: { currentUserId: number | null }) {
  const users = useApi<AdminUserRow[]>("/api/admin/users");
  const centers = useApi<AdminCenterRow[]>("/api/admin/centers");
  const refresh = users.mutate;
  const centerRows = useMemo(() => centers.data ?? [], [centers.data]);
  const cols = useMemo(() => columns(currentUserId, centerRows, () => void refresh()), [currentUserId, centerRows, refresh]);

  if (users.error && !users.data) return <InlineError error={users.error} onRetry={() => void refresh()} />;
  if (centers.error && !centers.data) return <InlineError error={centers.error} onRetry={() => void centers.mutate()} />;
  if (!users.data || !centers.data) return <Skeleton className="h-72 w-full" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <NewUserDialog centers={centerRows} onDone={() => void refresh()} />
      </div>
      <DataTable
        columns={cols}
        data={users.data}
        getRowId={(r) => String(r.user_id)}
        filters={[{ column: "name", placeholder: "Filter by name…" }]}
        emptyMessage="No users yet."
      />
    </div>
  );
}
