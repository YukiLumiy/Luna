import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToggleSwitch } from "./ToggleSwitch";
import { StatusLine } from "./StatusLine";
import { useT } from "../i18n";

interface FixStatus {
  present: number;
  total: number;
}

/** Applies / removes the skybox fix and optionally re-applies it on every launch. */
export function SkyboxFixSection() {
  const t = useT();
  const [status, setStatus] = useState<FixStatus | null>(null);
  const [onLaunch, setOnLaunch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setStatus(await invoke<FixStatus>("get_skybox_fix_status"));
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
    invoke<{ skybox_fix_on_launch?: boolean }>("get_settings")
      .then((s) => setOnLaunch(Boolean(s.skybox_fix_on_launch)))
      .catch(() => undefined);
  }, []);

  async function run(cmd: "apply_skybox_fix" | "remove_skybox_fix", done: (n: number) => string) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      setMessage(done(await invoke<number>(cmd)));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function toggleOnLaunch(enabled: boolean) {
    setOnLaunch(enabled);
    try {
      await invoke("set_skybox_fix_on_launch", { enabled });
    } catch (err) {
      setOnLaunch(!enabled);
      setError(String(err));
    }
  }

  const summary =
    status === null
      ? "…"
      : status.present === status.total
        ? t("skyfix.all", { total: status.total })
        : status.present > 0
          ? t("skyfix.partial", { present: status.present, total: status.total })
          : t("skyfix.none");

  return (
    <section className="appearance-block">
      <h3>{t("skyfix.heading")}</h3>

      <div className="field-column">
        <p className="appearance-hint">
          {t("skyfix.hint")}
        </p>
        <p className="appearance-hint">{summary}</p>
        <div className="appearance-row">
          <button
            className="apply-btn"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={() => run("apply_skybox_fix", (n) => t("skyfix.applied", { n }))}
          >
            {busy ? t("common.working") : t("skyfix.applyBtn")}
          </button>
          <button
            className="apply-btn"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={() => run("remove_skybox_fix", (n) => t("skyfix.removed", { n }))}
          >
            {t("common.remove")}
          </button>
        </div>
        <StatusLine text={error ?? message} error={Boolean(error)} />
      </div>

      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("skyfix.onLaunch")}</span>
          <p className="appearance-hint">
            {t("skyfix.onLaunchHint")}
          </p>
        </div>
        <ToggleSwitch
          checked={onLaunch}
          label={t("skyfix.onLaunchToggle")}
          onChange={toggleOnLaunch}
        />
      </div>
    </section>
  );
}
