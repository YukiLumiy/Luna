import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../i18n";
import { useArmed } from "../useArmed";
import { StatusLine } from "./StatusLine";

interface RobloxInstall {
  version: string | null;
  folder: string | null;
}

/** The last panel: removes the Roblox that Luna installed, so the next launch downloads it fresh. */
export function MaintenanceSection() {
  const t = useT();
  const { armed, arm, disarm } = useArmed();
  const [install, setInstall] = useState<RobloxInstall | null | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    invoke<RobloxInstall>("get_roblox_install")
      .then(setInstall)
      .catch(() => setInstall(null));

  useEffect(() => {
    void load();
  }, []);

  async function reinstall() {
    if (armed === null) return arm("reinstall");
    disarm();
    setError(null);
    setMessage(null);
    try {
      await invoke("reinstall_roblox");
      setMessage(t("update.reinstalled"));
    } catch (e) {
      setError(String(e));
    }
    void load();
  }

  const present = Boolean(install?.version);

  return (
    <section className="appearance-block">
      <h3>{t("repair.heading")}</h3>
      <div className={`server-card ${present ? "server-card--live" : ""}`}>
        <span className="server-card-head">{t("repair.label")}</span>
        <strong className="version-card-number">
          {install === undefined ? "…" : present ? install?.version : t("repair.none")}
        </strong>
        {install?.folder && <span className="server-meta">{install.folder}</span>}
        <div className="server-chips">
          <span className={`server-chip ${present ? "server-chip--good" : "server-chip--dim"}`}>
            {present ? t("roblox.chipOnPc") : t("roblox.chipNotYet")}
          </span>
        </div>
        <p className="appearance-hint version-card-note">{t("repair.hint")}</p>
        <div className="appearance-row">
          <button
            className={`apply-btn apply-btn--full ${armed === "reinstall" ? "apply-btn--danger" : ""}`}
            data-armed={armed === "reinstall"}
            onClick={reinstall}
          >
            <span key={armed === "reinstall" ? "c" : "n"} className="swap-label">
              {armed === "reinstall" ? t("update.reinstallConfirm") : t("update.reinstall")}
            </span>
          </button>
        </div>
      </div>
      <StatusLine text={error ?? message} error={Boolean(error)} />
    </section>
  );
}
