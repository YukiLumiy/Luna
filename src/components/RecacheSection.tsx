import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToggleSwitch } from "./ToggleSwitch";
import { useT } from "../i18n";

interface RecacheStatus {
  has_snapshot: boolean;
  snapshot_bytes: number;
  saved_at: number | null;
  cache_bytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** ReCache: a saved copy of Roblox's cache, so clearing it doesn't mean downloading everything again. */
export function RecacheSection() {
  const t = useT();
  const [status, setStatus] = useState<RecacheStatus | null>(null);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<RecacheStatus>("get_recache_status").then(setStatus).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    invoke<{ recache_auto?: boolean }>("get_settings")
      .then((s) => setAuto(Boolean(s.recache_auto)))
      .catch(() => undefined);
  }, [refresh]);

  async function toggleAuto(enabled: boolean) {
    setAuto(enabled);
    try {
      // Read-modify-write on the latest settings, so other sections' changes aren't undone.
      const latest = await invoke<Record<string, unknown>>("get_settings");
      await invoke("update_settings", { settings: { ...latest, recache_auto: enabled } });
    } catch (e) {
      setAuto(!enabled);
      setError(String(e));
    }
  }

  async function run(cmd: "recache_save" | "recache_restore", done: "recache.savedDone" | "recache.restoredDone") {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const bytes = await invoke<number>(cmd);
      setMessage(t(done, { size: formatBytes(bytes) }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const summary = !status
    ? "…"
    : status.has_snapshot && status.saved_at
      ? t("recache.status", {
          size: formatBytes(status.snapshot_bytes),
          when: new Date(status.saved_at * 1000).toLocaleString(),
          cache: formatBytes(status.cache_bytes),
        })
      : t("recache.none");

  return (
    <section className="appearance-block">
      <h3>{t("recache.heading")}</h3>
      <p className="appearance-hint">{t("recache.hint")}</p>
      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("recache.auto")}</span>
          <p className="appearance-hint">{t("recache.autoHint")}</p>
        </div>
        <ToggleSwitch checked={auto} label={t("recache.autoToggle")} onChange={toggleAuto} />
      </div>
      <p className="appearance-hint">{summary}</p>
      <div className="appearance-row">
        <button className="apply-btn" style={{ flex: 1 }} disabled={busy} onClick={() => run("recache_save", "recache.savedDone")}>
          {busy ? t("common.working") : t("recache.saveNow")}
        </button>
        <button
          className="apply-btn"
          style={{ flex: 1 }}
          disabled={busy || !status?.has_snapshot}
          onClick={() => run("recache_restore", "recache.restoredDone")}
        >
          {t("recache.restoreNow")}
        </button>
      </div>
      {message && <p className="appearance-hint">{message}</p>}
      {error && <p className="flag-error">{error}</p>}
    </section>
  );
}
