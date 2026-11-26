import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useArmed } from "../useArmed";
import { ToggleSwitch } from "./ToggleSwitch";
import { useT } from "../i18n";
import { PatchNotes } from "./PatchNotes";
import { allPatchNotes } from "../patchNotes";
import { autoUpdateEnabled, checkForUpdate, installUpdate, setAutoUpdate, useUpdateState } from "../updater";

/** Shows the installed version, checks GitHub for a newer one, and installs it. */
export function UpdateSection() {
  const t = useT();
  const s = useUpdateState();
  const [version, setVersion] = useState("");
  const [auto, setAuto] = useState(autoUpdateEnabled());
  const [showNotes, setShowNotes] = useState(false);
  // The Roblox that Luna installed (and the button that removes it, so the next launch downloads it again).
  const [roblox, setRoblox] = useState<string | null | undefined>(undefined);
  const [robloxMsg, setRobloxMsg] = useState<string | null>(null);
  const [robloxErr, setRobloxErr] = useState<string | null>(null);
  const { armed, arm, disarm } = useArmed();

  const loadRoblox = () =>
    invoke<{ version: string | null }>("get_roblox_install")
      .then((r) => setRoblox(r.version))
      .catch(() => setRoblox(null));

  async function reinstall() {
    if (armed === null) return arm("reinstall");
    disarm();
    setRobloxErr(null);
    try {
      await invoke("reinstall_roblox");
      setRobloxMsg(t("update.reinstalled"));
    } catch (e) {
      setRobloxErr(String(e));
    }
    void loadRoblox();
  }

  useEffect(() => {
    getVersion().then(setVersion).catch(() => undefined);
    void loadRoblox();
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
        {roblox !== undefined && (
          <p className="appearance-hint">{roblox ? t("update.robloxVersion", { v: roblox }) : t("update.robloxNone")}</p>
        )}
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
        <button
          className={`reset-btn flag-reset-all ${armed === "reinstall" ? "reset-btn--danger" : ""}`}
          data-armed={armed === "reinstall"}
          onClick={reinstall}
        >
          <span key={armed === "reinstall" ? "c" : "n"} className="swap-label">
            {armed === "reinstall" ? t("update.reinstallConfirm") : t("update.reinstall")}
          </span>
        </button>
        {robloxMsg && !robloxErr && <p className="appearance-hint">{robloxMsg}</p>}
        {robloxErr && <p className="flag-error">{robloxErr}</p>}
        <button className="reset-btn flag-reset-all" onClick={() => setShowNotes(true)}>
          {t("update.viewNotes")}
        </button>
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
      {showNotes && <PatchNotes title={t("update.notesTitle")} entries={allPatchNotes()} onClose={() => setShowNotes(false)} />}
    </section>
  );
}
