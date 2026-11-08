"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Radix Select items can't have an empty value, so "no filter" is its own value. */
export const ALL = "ALL";

export type FilterOption = { value: string; label: string };

/** A list page's filter dropdown: its first entry is ALL, labelled allLabel. */
export function FilterSelect({
  label,
  allLabel,
  value,
  onChange,
  options,
  className = "w-40",
}: {
  label: string;
  allLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly FilterOption[];
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={`Filter by ${label}`} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
