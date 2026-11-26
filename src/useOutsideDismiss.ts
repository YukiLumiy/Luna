import { useEffect, useRef } from "react";

/**
 * While `active`, a press anywhere outside the element(s) marked `data-editing="true"` calls
 * `onDismiss` — how a rename / edit mode ends when the person clicks somewhere else. Mark the
 * input and its buttons (or their whole row) with `data-editing="true"` so that using them is
 * not mistaken for "somewhere else".
 */
export function useOutsideDismiss(active: boolean, onDismiss: () => void) {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;

  useEffect(() => {
    if (!active) return;
    const onDown = (e: globalThis.PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el?.closest('[data-editing="true"]')) latest.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [active]);
}
