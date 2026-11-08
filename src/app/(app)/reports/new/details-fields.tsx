"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { humanize } from "@/app/(app)/emergencies/format";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FieldErrors } from "@/lib/api-contract";
import type { EmergencyType } from "@/lib/enums";
import { TRENDS } from "@/lib/validators/observations";

// The report form's details section, which changes with the emergency type:
// fixed fields for the types with their own validator branch, a key/value
// editor for the rest. Trend is on every type.

/** One typed key/value pair. rowKey keeps React's row identity when a middle row is removed. */
export type FreeDetail = { rowKey: number; name: string; value: string };

export type DetailValues = {
  water_level_m: string;
  roads_submerged: string;
  magnitude: string;
  buildings_collapsed: string;
  new_cases: string;
  deaths: string;
  trend: string;
  free: FreeDetail[];
};

type FixedName = Exclude<keyof DetailValues, "trend" | "free">;

export const EMPTY_DETAILS: DetailValues = {
  water_level_m: "",
  roads_submerged: "",
  magnitude: "",
  buildings_collapsed: "",
  new_cases: "",
  deaths: "",
  trend: "",
  free: [],
};

const FIXED_FIELDS: Partial<Record<EmergencyType, readonly { name: FixedName; label: string }[]>> = {
  FLOOD: [
    { name: "water_level_m", label: "Water level (m)" },
    { name: "roads_submerged", label: "Roads submerged" },
  ],
  EARTHQUAKE: [
    { name: "magnitude", label: "Magnitude (0 to 10)" },
    { name: "buildings_collapsed", label: "Buildings collapsed" },
  ],
  EPIDEMIC: [
    { name: "new_cases", label: "New cases" },
    { name: "deaths", label: "Deaths" },
  ],
};

const FREE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const NO_TREND = "NOT_RECORDED"; // Radix Select items can't have an empty value

/** A form box's text as a number. Number("") is 0, so blank becomes NaN and fails with a clear message. */
export const toNumber = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));

const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** A free value: a number only if it's a plain decimal, so "007", "0x1F" and "Infinity" stay as typed. */
function freeValue(text: string): number | string {
  const trimmed = text.trim();
  const number = Number(trimmed);
  return PLAIN_DECIMAL.test(trimmed) && Number.isFinite(number) ? number : trimmed;
}

/** The details object for the request body, and any problems only the form can see (the API allows any key). */
export function buildDetails(type: EmergencyType, values: DetailValues): { details: Record<string, unknown>; errors: FieldErrors } {
  const details: Record<string, unknown> = {};
  const errors: FieldErrors = {};

  for (const { name } of FIXED_FIELDS[type] ?? []) details[name] = toNumber(values[name]);

  if (!FIXED_FIELDS[type]) {
    const seen = new Set<string>();
    for (const { rowKey, name, value } of values.free) {
      const key = name.trim();
      if (!FREE_KEY.test(key)) {
        errors[`details.free.${rowKey}.name`] = "Lowercase letters, digits and _, starting with a letter";
      } else if (key === "trend") {
        errors[`details.free.${rowKey}.name`] = "Trend has its own field above";
      } else if (seen.has(key)) {
        errors[`details.free.${rowKey}.name`] = "This name is already used";
      }
      if (value.trim() === "") errors[`details.free.${rowKey}.value`] = "Enter a value";
      seen.add(key);
      details[key] = freeValue(value);
    }
  }

  if (values.trend) details.trend = values.trend;
  return { details, errors };
}

export function DetailsFields({
  type,
  values,
  fields,
  onChange,
  onClearField,
}: {
  type: EmergencyType;
  values: DetailValues;
  fields: FieldErrors;
  onChange: (change: Partial<DetailValues>) => void;
  onClearField: (name: string) => void;
}) {
  const nextKey = useRef(1);
  const fixed = FIXED_FIELDS[type];

  function updateFree(rowKey: number, change: Partial<FreeDetail>) {
    onChange({ free: values.free.map((row) => (row.rowKey === rowKey ? { ...row, ...change } : row)) });
    for (const name of Object.keys(change)) onClearField(`details.free.${rowKey}.${name}`);
  }

  return (
    <div className="flex flex-col gap-3">
      {fields.details && <p className="text-sm text-destructive">{fields.details}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        {fixed?.map(({ name, label }) => {
          const error = fields[`details.${name}`];
          return (
            <FormField key={name} htmlFor={name} label={label} error={error}>
              <Input
                id={name}
                type="number"
                min="0"
                step="any"
                value={values[name]}
                onChange={(e) => {
                  onChange({ [name]: e.target.value });
                  onClearField(`details.${name}`);
                }}
                aria-invalid={!!error}
              />
            </FormField>
          );
        })}
        <FormField htmlFor="trend" label="Trend (optional)" error={fields["details.trend"]}>
          <Select value={values.trend || NO_TREND} onValueChange={(v) => onChange({ trend: v === NO_TREND ? "" : v })}>
            <SelectTrigger id="trend" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_TREND}>Not recorded</SelectItem>
              {TRENDS.map((t) => (
                <SelectItem key={t} value={t}>
                  {humanize(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>

      {!fixed && (
        <div className="flex flex-col gap-2">
          {values.free.map((row, index) => {
            const nameError = fields[`details.free.${row.rowKey}.name`];
            const valueError = fields[`details.free.${row.rowKey}.value`];
            return (
              <div key={row.rowKey} className="grid items-start gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <FormField htmlFor={`free-name-${row.rowKey}`} label="Name" error={nameError}>
                  <Input
                    id={`free-name-${row.rowKey}`}
                    value={row.name}
                    placeholder="wind_speed_kmph"
                    onChange={(e) => updateFree(row.rowKey, { name: e.target.value })}
                    aria-invalid={!!nameError}
                  />
                </FormField>
                <FormField htmlFor={`free-value-${row.rowKey}`} label="Value" error={valueError}>
                  <Input
                    id={`free-value-${row.rowKey}`}
                    value={row.value}
                    onChange={(e) => updateFree(row.rowKey, { value: e.target.value })}
                    aria-invalid={!!valueError}
                  />
                </FormField>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="sm:mt-6"
                  aria-label={`Remove detail ${index + 1}`}
                  onClick={() => onChange({ free: values.free.filter((r) => r.rowKey !== row.rowKey) })}
                >
                  <Trash2 />
                </Button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => onChange({ free: [...values.free, { rowKey: nextKey.current++, name: "", value: "" }] })}
          >
            <Plus />
            Add detail
          </Button>
        </div>
      )}
    </div>
  );
}
