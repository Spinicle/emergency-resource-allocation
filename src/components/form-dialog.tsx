"use client";

import { useState } from "react";
import { toast } from "sonner";
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
import type { FieldErrors } from "@/lib/api-contract";
import { ApiError } from "@/lib/client";

/** Reads one form field as text. */
export type ReadField = (key: string) => string;

/**
 * A dialog around one form, shared by the admin and inventory pages. `submit`
 * sends the request and returns false when nothing changed. Field errors show
 * under their inputs, and every other message from the API goes to a toast as is.
 */
export function FormDialog({
  trigger,
  title,
  description,
  savedMessage,
  submit,
  onDone,
  children,
}: {
  trigger: React.ReactNode;
  title: string;
  description?: string;
  savedMessage: string;
  submit: (read: ReadField) => Promise<boolean | void>;
  /** Refetch after a save or a refusal, since a 409 usually means the row changed. */
  onDone: () => void;
  children: (fields: FieldErrors) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFields({});
    try {
      const changed = await submit((key) => String(form.get(key) ?? ""));
      if (changed !== false) {
        toast.success(savedMessage);
        onDone();
      }
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      onDone();
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
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          {children(fields)}
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
