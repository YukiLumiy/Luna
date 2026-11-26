/**
 * The moon rising on the horizon, ringed by slowly turning dotted halos.
 * The moon itself is low-poly: a disc cut into flat triangles, each shaded by
 * how much it faces the light (upper left). While the pointer is over it (or the
 * Launch / Settings buttons) HeroBackground adds `hero--spin`: the moon takes one
 * lazy full turn.
 */

// Same tiny deterministic generator as the stars, so the facets never reshuffle.
const rnd = (() => {
  let s = 11;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
})();

type P = [number, number];

// Rings of vertices, centre outwards. Inner rings are nudged so the facets are uneven;
// the outer ring only turns, so the silhouette is a clean 18-sided polygon.
const RING_R = [0.34, 0.68, 1];
const RING_N = [6, 12, 18];

const rings: P[][] = RING_R.map((r, k) => {
  const n = RING_N[k];
  const step = (Math.PI * 2) / n;
  const outer = k === RING_R.length - 1;
  return Array.from({ length: n }, (_, i) => {
    const a = i * step + (outer ? 0 : (rnd() - 0.5) * step * 0.7) + (k % 2 ? step / 2 : 0);
    const rr = outer ? r : r * (1 + (rnd() - 0.5) * 0.22);
    return [50 + 50 * rr * Math.cos(a), 50 + 50 * rr * Math.sin(a)] as P;
  });
});

const angleOf = ([x, y]: P) => {
  const a = Math.atan2(y - 50, x - 50);
  return a < 0 ? a + Math.PI * 2 : a;
};

/** Triangles between two closed rings, merged by angle. */
function strip(inner: P[], outer: P[]): [P, P, P][] {
  const tris: [P, P, P][] = [];
  // start both rings at their smallest angle
  const rot = (ring: P[]) => {
    let m = 0;
    ring.forEach((p, i) => { if (angleOf(p) < angleOf(ring[m])) m = i; });
    return ring.slice(m).concat(ring.slice(0, m));
  };
  const A = rot(inner);
  const B = rot(outer);
  const ang = (ring: P[], i: number) => angleOf(ring[i % ring.length]) + (i >= ring.length ? Math.PI * 2 : 0);
  let a = 0;
  let b = 0;
  while (a < A.length || b < B.length) {
    const takeA = b >= B.length || (a < A.length && ang(A, a + 1) <= ang(B, b + 1));
    if (takeA) {
      tris.push([A[a % A.length], A[(a + 1) % A.length], B[b % B.length]]);
      a++;
    } else {
      tris.push([A[a % A.length], B[b % B.length], B[(b + 1) % B.length]]);
      b++;
    }
  }
  return tris;
}

const FACETS: [P, P, P][] = [
  ...rings[0].map((p, i, r) => [[50, 50], p, r[(i + 1) % r.length]] as [P, P, P]),
  ...strip(rings[0], rings[1]),
  ...strip(rings[1], rings[2]),
];

const LIGHT = (() => {
  const v = [-0.5, -0.6, 0.62];
  const l = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / l);
})();
const POLYS = FACETS.map((tri) => {
  const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
  const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
  const nx = (cx - 50) / 50;
  const ny = (cy - 50) / 50;
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const lit = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  const t = Math.min(1, Math.max(0, 0.18 + 0.82 * lit + (rnd() - 0.5) * 0.16));
  // Mixed from the theme's two moon colours, so a palette change recolours the moon too.
  const color = `color-mix(in srgb, var(--moon-lit) ${Math.round(t * 100)}%, var(--moon-shade))`;
  return { points: tri.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "), color };
});

/** The low-poly moon itself (no halos), coloured by the current palette and theme. */
export function MoonDisc() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden>
      {POLYS.map((p, i) => (
        <polygon key={i} points={p.points} style={{ fill: p.color, stroke: p.color }} strokeWidth="0.35" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export function MoonEmblem({ busy = false }: { busy?: boolean }) {
  return (
    <div className={`moon-emblem ${busy ? "moon-emblem--busy" : ""}`}>
      <div className="glow" />
      <svg className="halos" viewBox="0 0 560 281" aria-hidden>
        <circle cx="280" cy="280" r="168" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
        <circle className="halo" cx="280" cy="280" r="208" fill="none" stroke="currentColor" strokeOpacity="0.6" strokeWidth="2" strokeDasharray="2 14" strokeLinecap="round" />
        <circle className="halo halo--b" cx="280" cy="280" r="248" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" strokeDasharray="1 20" strokeLinecap="round" />
      </svg>
      <div className="disc-pos">
        <div className="disc">
          <MoonDisc />
        </div>
      </div>
      {busy && <span className="moon-pulse" />}
    </div>
  );
}
