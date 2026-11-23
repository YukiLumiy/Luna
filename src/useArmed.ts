import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two-step confirmation for delete buttons: the first click "arms" the button (it shows
 * "Delete?"), the second confirms. The button disarms by itself after a few seconds, and as
 * soon as the person clicks anywhere else, presses Escape, or leaves the window.
 *
 * The armed button must carry `data-armed="true"` so a click on it isn't mistaken for
 * "somewhere else".
 */
export function useArmed(timeoutMs = 3500) {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const disarm = useCallback(() => {
    window.clearTimeout(timer.current);
    setArmed(null);
  }, []);

  const arm = useCallback(
    (id: string) => {
      setArmed(id);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setArmed(null), timeoutMs);
    },
    [timeoutMs],
  );

  useEffect(() => {
    if (armed === null) return;
    const onDown = (e: globalThis.PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el?.closest('[data-armed="true"]')) disarm();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") disarm();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", disarm);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", disarm);
    };
  }, [armed, disarm]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { armed, arm, disarm };
}
