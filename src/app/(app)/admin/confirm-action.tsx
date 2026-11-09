"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** A button that asks first, then runs. The API's message for a refusal goes to a toast as is. */
export function ConfirmAction({
  label,
  title,
  description,
  actionLabel,
  doneMessage,
  destructive = true,
  run,
  onDone,
}: {
  label: string;
  title: string;
  description: string;
  actionLabel: string;
  doneMessage: string;
  destructive?: boolean;
  run: () => Promise<unknown>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await run();
      toast.success(doneMessage);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That didn't work");
      setOpen(false);
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <Button variant={destructive ? "destructive" : "outline"} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={(e) => {
              e.preventDefault(); // stay open until it has finished
              void confirm();
            }}
          >
            {busy ? "Working…" : actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
