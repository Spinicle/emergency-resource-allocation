import { useState } from "react";

/**
 * value, or the last defined one while it's undefined. A new filter is a new
 * SWR key, so the data is undefined until it answers; keeping the last rows
 * meanwhile keeps the table mounted, with its sort and page.
 */
export function useLastValue<T>(value: T | undefined): T | undefined {
  const [last, setLast] = useState<T>();
  if (value !== undefined && value !== last) setLast(value);
  return value ?? last;
}
