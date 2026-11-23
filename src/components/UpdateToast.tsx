import { useState } from "react";
import { installUpdate, useUpdateState } from "../updater";
import { useT } from "../i18n";

/** Top-right notice when a newer Luna is available (checked when the app starts). */
export function UpdateToast() {
  const t = useT();
  const s = useUpdateState();
  // dismissed for this session, per version
  const [dismissed, setDismissed] = useState<string | null>(null);

  const available = s.kind === "available" && dismissed !== s.version;
  const downloading = s.kind === "downloading";
  if (!available && !downloading) return null;

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <div className="update-toast-dot" aria-hidden />
      <div className="update-toast-text">
        {downloading ? (
          <>
            <strong>{t("update.toastDownloading", { v: s.version })}</strong>
            {s.percent !== null && (
              <span className="update-toast-bar" aria-hidden>
                <i style={{ width: `${s.percent}%` }} />
              </span>
            )}
          </>
        ) : (
          <strong>{t("update.toast", { v: s.kind === "available" ? s.version : "" })}</strong>
        )}
      </div>
      {s.kind === "available" && (
        <div className="update-toast-actions">
          <button className="update-toast-btn update-toast-btn--main" onClick={installUpdate}>
            {t("update.updateNow")}
          </button>
          <button className="update-toast-btn" onClick={() => setDismissed(s.version)}>
            {t("update.later")}
          </button>
        </div>
      )}
    </div>
  );
}
