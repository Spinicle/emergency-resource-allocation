"use client";

import { Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ChoiceSelect } from "@/components/choice-select";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FieldErrors } from "@/lib/api-contract";
import { api, ApiError } from "@/lib/client";
import type { EmergencyCreated, EmergencyHeader } from "@/lib/emergency-types";
import { EMERGENCY_TYPES } from "@/lib/enums";
import type { CreateEmergencyInput, UpdateEmergencyInput } from "@/lib/validators/emergencies";
import { toDateTimeInput } from "./format";

/** Statuses the edit form offers. Closing is its own action (with a confirmation) on the detail page. */
const EDIT_STATUSES = ["ACTIVE", "CONTAINED"] as const;

/**
 * "New emergency", or "Edit" when given an emergency. Creating opens the new
 * emergency's page; editing calls onSaved so the page refetches.
 */
export function EmergencyDialog({ emergency, onSaved }: { emergency?: EmergencyHeader; onSaved?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});
  // What the form opened with. The emergency prop can refetch while the dialog
  // is open, so comparing against it would count a stale input as a change.
  const [loaded, setLoaded] = useState(emergency);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "");
    const startTime = text("start_time");

    setPending(true);
    setFields({});
    try {
      if (loaded) {
        // Only what the user changed, so a stale form can't undo someone else's
        // edit. An untouched start time also keeps its seconds (the input shows minutes).
        const name = text("name").trim();
        const description = text("description").trim();
        const body: UpdateEmergencyInput = {
          ...(name !== loaded.name && { name }),
          ...(text("type") !== loaded.type && { type: text("type") as UpdateEmergencyInput["type"] }),
          ...(description !== (loaded.description ?? "") && { description }),
          ...(text("status") !== loaded.status && { status: text("status") as UpdateEmergencyInput["status"] }),
          ...(startTime && startTime !== toDateTimeInput(loaded.start_time) && { start_time: startTime }),
        };
        if (Object.keys(body).length === 0) {
          setOpen(false);
          return;
        }
        await api(`/api/emergencies/${loaded.emergency_id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast.success("Emergency updated");
        setOpen(false);
        onSaved?.();
      } else {
        // A blank start time means now.
        const body: CreateEmergencyInput = {
          name: text("name"),
          type: text("type") as CreateEmergencyInput["type"],
          description: text("description"),
          ...(startTime && { start_time: startTime }),
        };
        const created = await api<EmergencyCreated>("/api/emergencies", { method: "POST", body: JSON.stringify(body) });
        toast.success("Emergency created. Add its impacted locations here.");
        setOpen(false);
        router.push(`/emergencies/${created.emergency_id}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the emergency");
      if (err instanceof ApiError && err.fields) setFields(err.fields);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setLoaded(emergency);
        else setFields({});
      }}
    >
      <DialogTrigger asChild>
        {emergency ? (
          <Button variant="outline" size="sm">
            <Pencil />
            Edit
          </Button>
        ) : (
          <Button size="sm">
            <Plus />
            New emergency
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{emergency ? "Edit emergency" : "New emergency"}</DialogTitle>
          <DialogDescription>
            {emergency
              ? "The type can't change once a location has a field observation."
              : "It starts ACTIVE. You add its impacted locations on the next page."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <FormField htmlFor="name" label="Name" error={fields.name}>
            <Input id="name" name="name" defaultValue={loaded?.name} aria-invalid={!!fields.name} autoFocus />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField htmlFor="type" label="Type" error={fields.type}>
              <ChoiceSelect
                id="type"
                name="type"
                defaultValue={loaded?.type ?? "FLOOD"}
                options={EMERGENCY_TYPES}
                invalid={!!fields.type}
              />
            </FormField>
            {loaded && (
              <FormField htmlFor="status" label="Status" error={fields.status}>
                <ChoiceSelect
                  id="status"
                  name="status"
                  defaultValue={loaded.status}
                  options={EDIT_STATUSES}
                  invalid={!!fields.status}
                />
              </FormField>
            )}
          </div>
          <FormField
            htmlFor="start_time"
            label={emergency ? "Started at (IST)" : "Started at (IST, blank = now)"}
            error={fields.start_time}
          >
            <Input
              id="start_time"
              name="start_time"
              type="datetime-local"
              defaultValue={toDateTimeInput(loaded?.start_time)}
              aria-invalid={!!fields.start_time}
            />
          </FormField>
          <FormField htmlFor="description" label="Description" error={fields.description}>
            <Textarea
              id="description"
              name="description"
              defaultValue={loaded?.description ?? ""}
              aria-invalid={!!fields.description}
            />
          </FormField>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
