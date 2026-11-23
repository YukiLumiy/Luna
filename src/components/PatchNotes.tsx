import { useEffect, type ReactNode } from "react";
import { useT } from "../i18n";

interface PatchNotesProps {
  version: string;
  notes: string;
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

/** Shown once, on the first start after an update. */
export function PatchNotes({ version, notes, onClose }: PatchNotesProps) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={t("update.whatsNew", { v: version })} onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{t("update.whatsNew", { v: version })}</h3>
        <div className="modal-body">
          <Notes text={notes} />
        </div>
        <button className="apply-btn apply-btn--full" onClick={onClose} autoFocus>
          {t("update.gotIt")}
        </button>
      </div>
    </div>
  );
}
