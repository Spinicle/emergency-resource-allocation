"use client";

import { Plus } from "lucide-react";
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
import type { FieldErrors } from "@/lib/api-contract";
import { api, ApiError } from "@/lib/client";
import type { ImpactCreated } from "@/lib/emergency-types";

/** "Add impact": POST /api/emergencies/[id]/impacts, then onAdded so the page refetches. */
export function AddImpactDialog({ emergencyId, onAdded }: { emergencyId: number; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    // Number("") is 0, a real coordinate, so a blank box becomes NaN; JSON sends
    // it as null, which the API reports as "Enter a latitude".
    const coordinate = (name: string) => {
      const text = String(form.get(name) ?? "").trim();
      return text === "" ? Number.NaN : Number(text);
    };

    setPending(true);
    setFields({});
    try {
      const created = await api<ImpactCreated>(`/api/emergencies/${emergencyId}/impacts`, {
        method: "POST",
        body: JSON.stringify({
          grid_id: String(form.get("grid_id") ?? ""),
          latitude: coordinate("latitude"),
          longitude: coordinate("longitude"),
        }),
      });
      toast.success(
        created.location_created
          ? `Impact added at ${created.grid_id}`
          : `Impact added. ${created.grid_id} already exists, so its saved coordinates (${created.latitude}, ${created.longitude}) are used.`,
      );
      setOpen(false);
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add the impact");
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
        <Button size="sm">
          <Plus />
          Add impact
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an impacted location</DialogTitle>
          <DialogDescription>
            If the grid id already exists, its saved coordinates are used instead of the ones entered here.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <FormField htmlFor="grid_id" label="Grid id" error={fields.grid_id}>
            <Input id="grid_id" name="grid_id" placeholder="BLR-HSR-LAYOUT" aria-invalid={!!fields.grid_id} autoFocus />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField htmlFor="latitude" label="Latitude" error={fields.latitude}>
              <Input id="latitude" name="latitude" type="number" step="any" placeholder="12.9121" aria-invalid={!!fields.latitude} />
            </FormField>
            <FormField htmlFor="longitude" label="Longitude" error={fields.longitude}>
              <Input id="longitude" name="longitude" type="number" step="any" placeholder="77.6446" aria-invalid={!!fields.longitude} />
            </FormField>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add impact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
