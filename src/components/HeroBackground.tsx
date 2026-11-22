import { useRef, useState, type AnimationEvent, type CSSProperties, type PointerEvent, type ReactNode } from "react";

interface HeroBackgroundProps {
  /** Drawn on the horizon, in the sky half (the moon). */
  sky?: ReactNode;
  /** Drawn below the horizon (title, status, buttons). */
  children: ReactNode;
}

// Pointer over any of these makes the moon take one turn.
const TARGETS = ".moon-emblem, .luna-btn--primary, .luna-btn--secondary";
const isTarget = (n: EventTarget | null) => n instanceof Element && n.closest(TARGETS) !== null;

// Fixed star positions (deterministic, so the sky never reshuffles).
const STARS = (() => {
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 46 }, () => ({ x: rnd() * 400, y: rnd() * 200, r: 0.6 + rnd() * 0.9, o: 0.25 + rnd() * 0.65, d: rnd() * 6, t: 3 + rnd() * 4 }));
})();

export function HeroBackground({ sky, children }: HeroBackgroundProps) {
  const [spin, setSpin] = useState(false);
  const spinning = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const raf = useRef(0);

  // A hover during a turn changes nothing: the current turn always finishes.
  function onOver(e: PointerEvent) {
    if (isTarget(e.target) && !spinning.current) {
      spinning.current = true;
      setSpin(true);
    }
  }
  function onEnd(e: AnimationEvent) {
    if (e.animationName !== "luna-turn") return;
    spinning.current = false;
    setSpin(false);
  }
  // Slight parallax: the stars and the moon drift against the pointer.
  function onMove(e: PointerEvent<HTMLDivElement>) {
    const el = root.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * 2;
    const y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      el.style.setProperty("--mx", x.toFixed(3));
      el.style.setProperty("--my", y.toFixed(3));
    });
  }

  return (
    <div ref={root} className={`hero ${spin ? "hero--spin" : ""}`} onPointerOver={onOver} onAnimationEnd={onEnd} onPointerMove={onMove}>
      <svg className="hero-stars" viewBox="0 0 400 200" preserveAspectRatio="xMidYMin slice" aria-hidden>
        {STARS.map((st, i) => (
          <circle key={i} className="star" cx={st.x} cy={st.y} r={st.r} fill="#f1f4ff"
            style={{ "--o": st.o, animationDelay: `${st.d}s`, animationDuration: `${st.t}s` } as CSSProperties} />
        ))}
      </svg>
      <div className="hero-sky">
        {sky}
        <i className="shoot" />
        <i className="shoot shoot--b" />
      </div>
      <div className="hero-water">
        <div className="hero-reflect" aria-hidden>
          <i /><i /><i />
        </div>
        <div className="hero-content">{children}</div>
      </div>
    </div>
  );
}
