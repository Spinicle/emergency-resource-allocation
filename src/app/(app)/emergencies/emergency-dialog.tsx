"use client";

import { Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FieldErrors } from "@/lib/api-contract";
import { api, ApiError } from "@/lib/client";
import type { EmergencyCreated, EmergencyHeader } from "@/lib/emergency-types";
import { EMERGENCY_TYPES } from "@/lib/enums";
import type { CreateEmergencyInput, UpdateEmergencyInput } from "@/lib/validators/emergencies";
import { humanize, toDateTimeInput } from "./format";

/** Statuses the edit form offers. Closing is its own action (with a confirmation) on the detail page. */
const EDIT_STATUSES = ["ACTIVE", "CONTAINED"] as const;

function ChoiceSelect({
  id,
  name,
  defaultValue,
  options,
  invalid,
}: {
  id: string;
  name: string;
  defaultValue: string;
  options: readonly string[];
  invalid: boolean;
}) {
  // With a name, Radix renders a hidden <select>, so the value is in FormData.
  return (
    <Select name={name} defaultValue={defaultValue}>
      <SelectTrigger id={id} aria-invalid={invalid} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {humanize(o)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * "New emergency", or "Edit" when given an emergency. Creating opens the new
 * emergency's page; editing calls onSaved so the page refetches.
 */
export function EmergencyDialog({ emergency, onSaved }: { emergency?: EmergencyHeader; onSaved?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "");
    const startTime = text("start_time");

    setPending(true);
    setFields({});
    try {
      if (emergency) {
        // The input shows minutes only, so an untouched start time isn't sent:
        // it would drop the stored seconds.
        const body: UpdateEmergencyInput = {
          name: text("name"),
          type: text("type") as UpdateEmergencyInput["type"],
          description: text("description"),
          status: text("status") as UpdateEmergencyInput["status"],
          ...(startTime && startTime !== toDateTimeInput(emergency.start_time) && { start_time: startTime }),
        };
        await api(`/api/emergencies/${emergency.emergency_id}`, { method: "PATCH", body: JSON.stringify(body) });
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
        if (!next) setFields({});
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
            <Input id="name" name="name" defaultValue={emergency?.name} aria-invalid={!!fields.name} autoFocus />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField htmlFor="type" label="Type" error={fields.type}>
              <ChoiceSelect
                id="type"
                name="type"
                defaultValue={emergency?.type ?? "FLOOD"}
                options={EMERGENCY_TYPES}
                invalid={!!fields.type}
              />
            </FormField>
            {emergency && (
              <FormField htmlFor="status" label="Status" error={fields.status}>
                <ChoiceSelect
                  id="status"
                  name="status"
                  defaultValue={emergency.status}
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
              defaultValue={toDateTimeInput(emergency?.start_time)}
              aria-invalid={!!fields.start_time}
            />
          </FormField>
          <FormField htmlFor="description" label="Description" error={fields.description}>
            <Textarea
              id="description"
              name="description"
              defaultValue={emergency?.description ?? ""}
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
