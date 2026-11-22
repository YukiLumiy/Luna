/**
 * Liquid Glass.
 *
 * Blur plus a translucent frame only looks like frosted plastic. What makes
 * glass look like glass is what happens at its edge, so every glass element here
 * gets, on top of a light blur and a tint:
 *
 *  1. Refraction at the rim — a displacement map is generated for the element's
 *     exact size and corner radius. It is ~0 across the face and bends the
 *     backdrop only inside a narrow bezel, as a thick convex edge would.
 *  2. Chromatic aberration — the map is applied three times (R, G, B) with
 *     slightly different strengths, so the bent edge splits into faint colour.
 *  3. Specular rims — drawn in CSS (glass.css); the highlight follows the pointer
 *     through the --px / --py / --near variables this module keeps up to date.
 *  4. Presses spring back (CSS), and the window itself is glass (windowEffects.ts).
 *
 * The map is applied with `backdrop-filter: url(#…)`, which Chromium (and so
 * WebView2) supports. One SVG filter exists per distinct element size and is
 * shared by every element of that size.
 */

const CONTROLS =
  ".glass-orb,.luna-btn--primary,.status-pill,.back-btn,.apply-btn,.reset-btn,.picker-btn,.preset-chip,.toggle," +
  ".theme-tile,.sky-face-btn,.icon-btn,.open-folder-btn,.theme-switch";
const CARDS = ".appearance-block";
const ALL = `${CONTROLS},${CARDS}`;

const SVG_NS = "http://www.w3.org/2000/svg";
const VARS = ["--lg", "--px", "--py", "--near"];
/** Strength of the red / green / blue copies. The spread is the aberration. */
const CHANNEL_SCALE = [1, 0.9, 0.8];
const MAX_FILTERS = 140;

let running = false;
let host: SVGDefsElement | null = null;
const filters = new Map<string, string>(); // key -> filter id
const maps = new Map<string, string>(); // key -> data URL
const tracked = new Set<HTMLElement>();
const dirty = new Set<HTMLElement>();
let ro: ResizeObserver | null = null;
let io: IntersectionObserver | null = null;
const visible = new Set<HTMLElement>(); // only these carry a filter: off-screen glass costs nothing
let mo: MutationObserver | null = null;
let frame = 0;
let pointer: { x: number; y: number } | null = null;
let pointerFrame = 0;
let counter = 0;

function ensureHost(): SVGDefsElement {
  if (host && host.isConnected) return host;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
  host = document.createElementNS(SVG_NS, "defs");
  svg.appendChild(host);
  document.body.appendChild(svg);
  return host;
}

/**
 * Displacement map for a rounded rectangle, as a PNG data URL.
 * R and G hold the x / y offset (0.5 = none). Inside the bezel the backdrop is
 * pulled in from deeper in the element, hardest at the very edge.
 */
function buildMap(w: number, h: number, radius: number, bezel: number): string {
  // Maps are smooth, so large ones are built at half size and scaled by the browser.
  const k = w * h > 40000 ? 0.5 : 1;
  const mw = Math.max(2, Math.round(w * k));
  const mh = Math.max(2, Math.round(h * k));
  const canvas = document.createElement("canvas");
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(mw, mh);
  const hw = mw / 2;
  const hh = mh / 2;
  const r = Math.min(radius * k, hw, hh);
  const bz = Math.max(1, bezel * k);
  for (let j = 0; j < mh; j++) {
    for (let i = 0; i < mw; i++) {
      const px = i + 0.5 - hw;
      const py = j + 0.5 - hh;
      const qx = Math.abs(px) - (hw - r);
      const qy = Math.abs(py) - (hh - r);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy);
      const depth = -(outside + Math.min(Math.max(qx, qy), 0) - r);
      let nx = 0;
      let ny = 0;
      if (outside > 0) {
        nx = (Math.sign(px) * ox) / outside;
        ny = (Math.sign(py) * oy) / outside;
      } else if (qx > qy) nx = Math.sign(px);
      else ny = Math.sign(py);
      let m = 0;
      if (depth < bz) m = Math.pow(1 - Math.max(depth, 0) / bz, 2.6);
      const o = (j * mw + i) * 4;
      img.data[o] = Math.round(255 * (0.5 - 0.5 * nx * m));
      img.data[o + 1] = Math.round(255 * (0.5 - 0.5 * ny * m));
      img.data[o + 2] = 128;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function channel(name: string, scale: number, row: string) {
  return (
    `<feDisplacementMap in="SourceGraphic" in2="m" scale="${scale.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="d${name}"/>` +
    `<feColorMatrix in="d${name}" type="matrix" values="${row}" result="${name}"/>`
  );
}

function ensureFilter(key: string, w: number, h: number, radius: number, bezel: number, maxShift: number): string {
  const known = filters.get(key);
  if (known) return known;
  if (filters.size >= MAX_FILTERS) prune();
  let url = maps.get(key);
  if (!url) {
    url = buildMap(w, h, radius, bezel);
    maps.set(key, url);
  }
  const id = `lg-${++counter}`;
  const S = maxShift * 2; // the map encodes ±0.5, so scale = 2 × the largest shift
  ensureHost().insertAdjacentHTML(
    "beforeend",
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}" color-interpolation-filters="sRGB">` +
      `<feImage href="${url}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="m"/>` +
      channel("R", S * CHANNEL_SCALE[0], "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0") +
      channel("G", S * CHANNEL_SCALE[1], "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0") +
      channel("B", S * CHANNEL_SCALE[2], "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0") +
      `<feBlend in="R" in2="G" mode="screen" result="rg"/><feBlend in="rg" in2="B" mode="screen"/></filter>`,
  );
  filters.set(key, id);
  return id;
}

/** Drops filters no element uses any more. */
function prune() {
  const used = new Set<string>();
  tracked.forEach((el) => {
    const m = /#(lg-\d+)/.exec(el.style.getPropertyValue("--lg"));
    if (m) used.add(m[1]);
  });
  for (const [key, id] of [...filters]) {
    if (used.has(id)) continue;
    host?.querySelector(`#${id}`)?.remove();
    filters.delete(key);
    maps.delete(key);
  }
}

function radiusOf(el: HTMLElement, w: number, h: number): number {
  const raw = getComputedStyle(el).borderTopLeftRadius;
  const px = raw.endsWith("%") ? (parseFloat(raw) / 100) * Math.min(w, h) : parseFloat(raw);
  return Math.min(Number.isFinite(px) ? px : 0, Math.min(w, h) / 2);
}

function apply(el: HTMLElement) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (w < 6 || h < 6) return;
  const card = el.matches(CARDS);
  const orb = el.matches(".glass-orb");
  const radius = Math.round(radiusOf(el, w, h));
  const small = Math.min(w, h);
  // Cards: a wide, gentle bezel. Controls: a tighter one that scales with their height.
  const bezel = orb ? small * 0.36 : card ? Math.min(Math.max(small * 0.1, 14), 24) : Math.min(Math.max(small * 0.48, 8), 18);
  const maxShift = orb ? bezel * 0.75 : card ? bezel * 0.85 : bezel * 0.95;
  const key = `${orb ? "o" : card ? "c" : "b"}-${w}x${h}-${radius}`;
  const id = ensureFilter(key, w, h, radius, bezel, maxShift);
  el.style.setProperty("--lg", `url(#${id})`);
}

function flush() {
  frame = 0;
  // Map generation is the expensive part, so each frame gets a budget of map pixels
  // (large maps are built at a quarter of their area, see buildMap).
  let budget = 90000;
  for (const el of dirty) {
    dirty.delete(el);
    if (el.isConnected) {
      const area = el.offsetWidth * el.offsetHeight;
      apply(el);
      budget -= area > 40000 ? area / 4 : area;
    }
    if (budget <= 0) break;
  }
  if (dirty.size) frame = requestAnimationFrame(flush);
}

function queue(el: HTMLElement) {
  if (!visible.has(el)) return;
  dirty.add(el);
  if (!frame) frame = requestAnimationFrame(flush);
}

function track(el: HTMLElement) {
  if (tracked.has(el)) return;
  tracked.add(el);
  ro?.observe(el);
  io?.observe(el);
}

function untrack(el: HTMLElement) {
  tracked.delete(el);
  visible.delete(el);
  dirty.delete(el);
  ro?.unobserve(el);
  io?.unobserve(el);
}

function scan(root: ParentNode, adding: boolean) {
  const found: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(ALL)) found.push(root);
  root.querySelectorAll?.<HTMLElement>(ALL).forEach((e) => found.push(e));
  found.forEach(adding ? track : untrack);
}

/* ---- pointer: the specular highlight follows the cursor ---- */

function onPointerMove(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
  if (!pointerFrame) pointerFrame = requestAnimationFrame(updatePointer);
}

function onPointerLeave() {
  pointer = null;
  if (!pointerFrame) pointerFrame = requestAnimationFrame(updatePointer);
}

function updatePointer() {
  pointerFrame = 0;
  const vh = window.innerHeight;
  tracked.forEach((el) => {
    const was = el.dataset.lgNear === "1";
    if (!pointer) {
      if (was) {
        el.style.setProperty("--near", "0");
        el.dataset.lgNear = "0";
      }
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.bottom < -80 || r.top > vh + 80) return;
    const reach = el.matches(CARDS) ? 150 : 90;
    const dx = Math.max(r.left - pointer.x, 0, pointer.x - r.right);
    const dy = Math.max(r.top - pointer.y, 0, pointer.y - r.bottom);
    const near = Math.max(0, 1 - Math.hypot(dx, dy) / reach);
    if (near > 0) {
      el.style.setProperty("--px", `${(pointer.x - r.left).toFixed(1)}px`);
      el.style.setProperty("--py", `${(pointer.y - r.top).toFixed(1)}px`);
      el.style.setProperty("--near", near.toFixed(3));
      el.dataset.lgNear = "1";
    } else if (was) {
      el.style.setProperty("--near", "0");
      el.dataset.lgNear = "0";
    }
  });
}

export function startGlass() {
  if (running) return;
  running = true;
  ensureHost();
  ro = new ResizeObserver((entries) => entries.forEach((e) => queue(e.target as HTMLElement)));
  // Glass is switched on while an element is on screen (plus a margin) and off again after.
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        if (e.isIntersecting) {
          visible.add(el);
          queue(el);
        } else {
          visible.delete(el);
          dirty.delete(el);
          el.style.removeProperty("--lg");
        }
      }
    },
    { rootMargin: "120px 0px" },
  );
  mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => n instanceof Element && scan(n, true));
      m.removedNodes.forEach((n) => n instanceof Element && scan(n, false));
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  scan(document.body, true);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
}

export function stopGlass() {
  if (!running) return;
  running = false;
  ro?.disconnect();
  mo?.disconnect();
  io?.disconnect();
  ro = mo = io = null;
  visible.clear();
  window.removeEventListener("pointermove", onPointerMove);
  document.documentElement.removeEventListener("pointerleave", onPointerLeave);
  cancelAnimationFrame(frame);
  cancelAnimationFrame(pointerFrame);
  frame = pointerFrame = 0;
  tracked.forEach((el) => {
    VARS.forEach((v) => el.style.removeProperty(v));
    delete el.dataset.lgNear;
  });
  tracked.clear();
  dirty.clear();
  host?.replaceChildren();
  filters.clear();
  maps.clear();
}

export const glassActive = () => running;
