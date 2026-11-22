/**
 * Crisp, high-contrast shapes that drift slowly behind the interface. Glass only
 * reads as glass when there is something with a clear outline to bend, so these
 * stay sharp-edged. Hidden unless a glass theme is active (see glass.css).
 */
export function GlassBackground() {
  return (
    <div className="glass-bg" aria-hidden>
      <i className="gb gb-moon" />
      <i className="gb gb-ring" />
      <i className="gb gb-sq" />
      <i className="gb gb-lines" />
      <i className="gb gb-bar gb-bar--a" />
      <i className="gb gb-bar gb-bar--b" />
      <i className="gb gb-dot gb-dot--a" />
      <i className="gb gb-dot gb-dot--b" />
      <i className="gb gb-dot gb-dot--c" />
    </div>
  );
}
