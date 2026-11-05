"use client";

import { cn } from "cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { QueueRow } from "@/lib/allocation-types";

// The explainable priority score (differentiator #1, docs/HANDOFF.md Appendix C):
// what each part adds, straight from the API (fn_priority_from_parts with the
// other parts at 0), so the weights stay in SQL. Each contribution is rounded
// to 2 dp, so they can differ from the score by 0.01; the score is the real one.

type Part = {
  key: "u" | "s" | "a" | "w" | "d";
  label: string;
  color: string;
  points: (r: QueueRow) => number;
  input: (r: QueueRow) => string;
};

const DEADLINE: Record<string, string> = {
  "1": "overdue or due within 6 h",
  "0.6": "due within 24 h",
  "0.2": "due later",
  "0": "no deadline",
};

const PARTS: Part[] = [
  { key: "u", label: "Urgency", color: "bg-chart-1", points: (r) => r.u_points, input: (r) => r.urgency },
  {
    key: "s",
    label: "Severity",
    color: "bg-chart-2",
    points: (r) => r.s_points,
    input: (r) => r.latest_severity ?? "no observation yet",
  },
  {
    key: "a",
    label: "Affected",
    color: "bg-chart-3",
    points: (r) => r.a_points,
    input: (r) => (r.latest_affected_pct === null ? "no observation yet" : `${r.latest_affected_pct}% affected`),
  },
  {
    key: "w",
    label: "Waiting",
    color: "bg-chart-4",
    points: (r) => r.w_points,
    input: (r) => `${r.hours_waiting} h waiting`,
  },
  {
    key: "d",
    label: "Deadline",
    color: "bg-chart-5",
    points: (r) => r.d_points,
    input: (r) => DEADLINE[String(r.d_part)] ?? `pressure ${r.d_part}`,
  },
];

const pts = (n: number) => n.toFixed(2);

/** The score as a bar of its five parts, out of 100. */
function Bar({ row, className }: { row: QueueRow; className?: string }) {
  return (
    <div className={cn("flex h-2 overflow-hidden rounded-full bg-muted", className)} aria-hidden>
      {PARTS.map((p) => (
        <div key={p.key} className={p.color} style={{ width: `${p.points(row)}%` }} />
      ))}
    </div>
  );
}

function PartList({ row }: { row: QueueRow }) {
  return (
    <ul className="grid gap-1">
      {PARTS.map((p) => (
        <li key={p.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
          <span className={cn("size-2 rounded-full", p.color)} aria-hidden />
          <span>
            {p.label} <span className="opacity-70">· {p.input(row)}</span>
          </span>
          <span className="font-mono tabular-nums">+{pts(p.points(row))}</span>
        </li>
      ))}
    </ul>
  );
}

/** Compact, for a queue cell: the score, its bar, and the parts on hover or focus. */
export function ScoreCell({ row }: { row: QueueRow }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex min-w-28 flex-col gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Priority ${pts(row.priority_score)}: ${PARTS.map((p) => `${p.label} ${pts(p.points(row))}`).join(", ")}`}
        >
          <span className="font-mono font-medium tabular-nums">{pts(row.priority_score)}</span>
          <Bar row={row} className="w-28" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-72">
        <PartList row={row} />
      </TooltipContent>
    </Tooltip>
  );
}

/** Full, for the item panel: the score, its bar and every part with its input. */
export function ScoreBreakdown({ row }: { row: QueueRow }) {
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-muted-foreground">Priority score</span>
        <span className="font-mono text-lg font-semibold tabular-nums">{pts(row.priority_score)}</span>
      </div>
      <Bar row={row} />
      <PartList row={row} />
    </div>
  );
}
