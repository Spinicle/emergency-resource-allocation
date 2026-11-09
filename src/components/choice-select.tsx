"use client";

import { humanize } from "@/app/(app)/emergencies/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** A form's dropdown over a fixed list. With a name, Radix renders a hidden <select>, so the value is in FormData. */
export function ChoiceSelect({
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
