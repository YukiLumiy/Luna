import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import type { PatchEntry } from "../patchNotes";

interface PatchNotesProps {
  /** Heading of the window. */
  title: string;
  /** One entry right after an update; every version when opened from Settings → Updates. */
  entries: PatchEntry[];
  onClose: () => void;
}

/** Renders the release notes (a little Markdown: headings, bullets, paragraphs). */
function Notes({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      blocks.push(
        <ul key={`u${blocks.length}`}>
          {bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) bullets.push(bullet[1]);
    else {
      flush();
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) blocks.push(<h4 key={`h${blocks.length}`}>{heading[1]}</h4>);
      else if (line) blocks.push(<p key={`p${blocks.length}`}>{line}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

/** The patch notes window: once after an update, and any time from Settings → Updates. */
export function PatchNotes({ title, entries, onClose }: PatchNotesProps) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Rendered into <body>: it is opened from inside scrolling, animated panels, which would
  // otherwise trap a `position: fixed` window inside themselves.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <div className="modal-body">
          {entries.map((e) => (
            <section className="modal-entry" key={e.version}>
              {entries.length > 1 && <h4 className="modal-version">v{e.version}</h4>}
              <Notes text={e.notes} />
            </section>
          ))}
        </div>
        <button className="apply-btn apply-btn--full" onClick={onClose} autoFocus>
          {t("update.gotIt")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
