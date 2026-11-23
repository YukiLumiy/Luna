interface StatusLineProps {
  text: string | null;
  error?: boolean;
  /** Keep the line's space even when empty (for panels where buttons are clicked repeatedly). */
  reserve?: boolean;
}

/**
 * The message under a row of buttons ("Applied 6 files."). It keeps a clear gap from the
 * buttons, and opens and closes smoothly instead of popping in and shoving the panel below
 * it down in one jump. With `reserve` its space is always there, so nothing moves at all.
 */
export function StatusLine({ text, error = false, reserve = false }: StatusLineProps) {
  const open = reserve || Boolean(text);
  return (
    <div className={`status-line ${open ? "status-line--open" : ""}`} aria-live="polite">
      <p className={`status-text ${error ? "status-text--error" : ""}`}>{text ?? "\u00A0"}</p>
    </div>
  );
}
