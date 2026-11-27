import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface SegmentedProps {
  options: { key: string; label: string }[];
  /** Index of the selected option, or -1 when none is selected. */
  active: number;
  onSelect: (index: number) => void;
}

interface Box { x: number; y: number; w: number; h: number }

/**
 * One framed row of options. The selected option's fill is a separate element that slides to
 * whichever option is picked (also across rows when a long set wraps), and the thin dividers
 * between options fade out next to the selected / hovered one.
 */
export function Segmented({ options, active, onSelect }: SegmentedProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  // No sliding on the very first paint: the fill should simply be there.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const chips = Array.from(el.querySelectorAll<HTMLElement>(".preset-chip"));
    const measure = () => {
      const chip = chips[active];
      const next = chip ? { x: chip.offsetLeft, y: chip.offsetTop, w: chip.offsetWidth, h: chip.offsetHeight } : null;
      setBox((prev) =>
        prev && next && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next,
      );
    };
    measure();
    // widths change when a font finishes loading or the language changes
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    chips.forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [active, options]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="preset-chips" ref={frame}>
      {box && (
        <span
          className={`preset-thumb ${ready ? "preset-thumb--live" : ""}`}
          aria-hidden
          style={{ width: box.w, height: box.h, transform: `translate(${box.x}px, ${box.y}px)` }}
        />
      )}
      {options.map((o, i) => (
        <button
          key={o.key}
          className={`preset-chip ${active === i ? "preset-chip--on" : ""}`}
          aria-pressed={active === i}
          onClick={() => onSelect(i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
