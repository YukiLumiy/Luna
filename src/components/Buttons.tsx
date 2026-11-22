import type { ReactNode } from "react";

interface PrimaryButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
}

/** Tiny crescent used inside the primary button. */
function MoonGlyph() {
  return (
    <svg className="luna-btn-glyph" width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="M15.5 3.2A9 9 0 1 0 20.8 14 7.2 7.2 0 0 1 15.5 3.2Z" fill="currentColor" />
    </svg>
  );
}

export function PrimaryButton({ children, onClick, disabled, loading }: PrimaryButtonProps) {
  return (
    <span className="luna-btn-wrap">
      <button className="luna-btn luna-btn--primary" onClick={onClick} disabled={disabled}>
        <span className="luna-btn-sheen" aria-hidden />
        {loading ? <span className="luna-spinner" aria-hidden /> : <MoonGlyph />}
        <span className="luna-btn-label">{children}</span>
      </button>
    </span>
  );
}

interface SecondaryButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}

/** Deliberately plain — no fill, no border. Sits below the primary action without competing with it. */
export function SecondaryButton({ children, onClick, disabled }: SecondaryButtonProps) {
  return (
    <button className="luna-btn luna-btn--secondary" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
