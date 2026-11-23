import { useEffect, useState } from "react";

interface Tip {
  text: string;
  x: number;
  y: number;
  below: boolean;
}

const TIP_W = 220; // matches max-width in .luna-tip

/**
 * Luna's own tooltip, instead of the browser's. Any element with a `title` (or `data-tip`)
 * gets it: on first hover the `title` is moved into `data-tip`, so the native tooltip never
 * shows, and this one appears after a short delay, above the element (below it if there's no
 * room). It also shows for keyboard focus, and hides on click, scroll, Escape or leaving.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let timer = 0;
    let current: Element | null = null;

    const hostOf = (t: EventTarget | null) => (t instanceof Element ? t.closest("[title],[data-tip]") : null);

    const take = (el: Element) => {
      const title = el.getAttribute("title");
      if (title !== null) {
        if (title.trim()) el.setAttribute("data-tip", title);
        el.removeAttribute("title");
      }
      return el.getAttribute("data-tip") ?? "";
    };

    const show = (el: Element) => {
      const text = el.getAttribute("data-tip");
      if (!text || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      const below = r.top < 52;
      const half = TIP_W / 2 + 8;
      const x = Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half);
      setTip({ text, x, y: below ? r.bottom + 8 : r.top - 8, below });
    };

    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setTip(null);
    };

    const start = (el: Element, delay: number) => {
      const text = take(el);
      if (el === current) return;
      hide();
      if (!text) return;
      current = el;
      timer = window.setTimeout(() => show(el), delay);
    };

    const onOver = (e: PointerEvent) => {
      const el = hostOf(e.target);
      if (el) start(el, 420);
    };
    const onOut = (e: PointerEvent) => {
      if (!current) return;
      const to = e.relatedTarget;
      if (!(to instanceof Node && current.contains(to))) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = hostOf(e.target);
      if (el && el instanceof HTMLElement && el.matches(":focus-visible")) start(el, 150);
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", (e) => e.key === "Escape" && hide());
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;
  return (
    <div
      className={`luna-tip ${tip.below ? "luna-tip--below" : ""}`}
      role="tooltip"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>
  );
}
