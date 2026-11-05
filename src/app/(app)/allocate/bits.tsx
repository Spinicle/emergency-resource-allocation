"use client";

import { cn } from "cn";
import { RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ApiError } from "@/lib/client";

// Small pieces shared by the queue and the item panel.

/**
 * A failed read, shown where its data would be. Reads never toast: SWR retries
 * them, and the toasts would pile up. Only writes toast.
 */
export function InlineError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
    >
      <span>{error.message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw />
        Retry
      </Button>
    </div>
  );
}

const TONES = {
  red: "border-transparent bg-destructive/10 text-destructive",
  amber: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  green: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  blue: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
  grey: "border-transparent bg-muted text-muted-foreground",
} as const;

export type Tone = keyof typeof TONES;

export function ToneBadge({ tone, className, children }: { tone: Tone; className?: string; children: React.ReactNode }) {
  return (
    <Badge variant="outline" className={cn(TONES[tone], className)}>
      {children}
    </Badge>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  // request_item / resource_request
  PENDING: "amber",
  OPEN: "amber",
  PARTIAL: "blue",
  PARTIALLY_FULFILLED: "blue",
  FULFILLED: "green",
  CANCELLED: "grey",
  // allocation
  RESERVED: "amber",
  DISPATCHED: "blue",
  DELIVERED: "green",
  // levels
  CRITICAL: "red",
  HIGH: "amber",
  MEDIUM: "blue",
  MODERATE: "blue",
  LOW: "grey",
};

/** A status, urgency or severity value with its colour. */
export function StatusBadge({ value }: { value: string }) {
  return <ToneBadge tone={STATUS_TONE[value] ?? "grey"}>{value.replaceAll("_", " ")}</ToneBadge>;
}
