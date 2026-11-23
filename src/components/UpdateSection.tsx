import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ToggleSwitch } from "./ToggleSwitch";
import { useT } from "../i18n";
import { autoUpdateEnabled, checkForUpdate, installUpdate, setAutoUpdate, useUpdateState } from "../updater";

/** Shows the installed version, checks GitHub for a newer one, and installs it. */
export function UpdateSection() {
  const t = useT();
  const s = useUpdateState();
  const [version, setVersion] = useState("");
  const [auto, setAuto] = useState(autoUpdateEnabled());

  useEffect(() => {
    getVersion().then(setVersion).catch(() => undefined);
  }, []);

  const text =
    s.kind === "checking" ? t("update.checking")
    : s.kind === "none" ? t("update.upToDate")
    : s.kind === "available" ? t("update.available", { v: s.version })
    : s.kind === "downloading" ? (s.percent !== null ? t("update.downloadingPct", { v: s.version, p: s.percent }) : t("update.downloading", { v: s.version }))
    : s.kind === "error" ? t("update.error")
    : "";

  return (
    <section className="appearance-block">
      <h3>{t("update.heading")}</h3>
      <div className="field-column">
        <p className="appearance-hint">Luna {version}</p>
        {text && <p className="appearance-hint">{text}</p>}
        {s.kind === "available" && s.notes && <p className="appearance-hint">{s.notes.slice(0, 240)}</p>}
        {s.kind === "error" && <p className="flag-error">{s.message}</p>}
        <div className="appearance-row">
          {s.kind === "available" ? (
            <button className="apply-btn apply-btn--full" onClick={installUpdate}>
              {t("update.install", { v: s.version })}
            </button>
          ) : (
            <button
              className="apply-btn apply-btn--full"
              disabled={s.kind === "checking" || s.kind === "downloading"}
              onClick={() => void checkForUpdate()}
            >
              {t("update.check")}
            </button>
          )}
        </div>
      </div>
      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("update.startup")}</span>
          <p className="appearance-hint">{t("update.startupHint")}</p>
        </div>
        <ToggleSwitch
          checked={auto}
          label={t("update.startupToggle")}
          onChange={(on) => {
            setAuto(on);
            setAutoUpdate(on);
          }}
        />
      </div>
    </section>
  );
}
