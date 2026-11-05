import { useEffect, useState } from "react";

/**
 * value, but only after it has stopped changing for delayMs. Search boxes use
 * it so the API is called when the user pauses, not on every keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
