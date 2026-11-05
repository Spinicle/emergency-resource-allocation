import { type Tone, ToneBadge } from "@/app/(app)/allocate/bits";
import type { EmergencyStatus, ImpactStatus } from "@/lib/enums";
import { humanize } from "./format";

// Emergency and impact statuses on /allocate's ToneBadge (its StatusBadge has
// no tones for these). Severity uses /allocate's StatusBadge as is.

const TONE: Record<EmergencyStatus | ImpactStatus, Tone> = {
  ACTIVE: "red",
  CONTAINED: "amber",
  STABILISED: "amber",
  CLOSED: "grey",
  RESOLVED: "green",
};

export function PhaseBadge({ value }: { value: EmergencyStatus | ImpactStatus }) {
  return <ToneBadge tone={TONE[value]}>{humanize(value)}</ToneBadge>;
}
