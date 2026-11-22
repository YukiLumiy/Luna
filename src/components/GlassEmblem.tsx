/**
 * Home emblem for the glass themes (replaces the moon): a glass sphere floating
 * above the horizon. Behind it turn dotted rings with small dots on them, so the
 * sphere has crisp things to bend as they pass behind its edge. The sphere is a
 * normal glass element (see liquidGlass.ts): refraction, colour fringing, rim light.
 */
export function GlassEmblem({ busy = false }: { busy?: boolean }) {
  return (
    <div className={`glass-emblem ${busy ? "glass-emblem--busy" : ""}`} aria-hidden>
      <svg className="ge-rings" viewBox="0 0 340 240">
        <circle cx="170" cy="148" r="78" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
        <g className="ge-spin">
          <circle cx="170" cy="148" r="104" fill="none" stroke="currentColor" strokeOpacity="0.6" strokeWidth="2" strokeDasharray="2 12" strokeLinecap="round" />
          <circle cx="274" cy="148" r="4.5" fill="currentColor" />
          <circle cx="92" cy="86" r="3" fill="currentColor" />
          <circle cx="132" cy="246" r="3.5" fill="currentColor" />
        </g>
        <g className="ge-spin ge-spin--b">
          <circle cx="170" cy="148" r="132" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" strokeDasharray="1 18" strokeLinecap="round" />
          <circle cx="38" cy="148" r="5.5" fill="currentColor" />
          <circle cx="236" cy="34" r="3" fill="currentColor" />
        </g>
      </svg>
      <div className="glass-orb" />
    </div>
  );
}
