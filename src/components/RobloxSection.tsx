import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useT } from "../i18n";
import { StatusLine } from "./StatusLine";
import { ToggleSwitch } from "./ToggleSwitch";
import type { BootProgress } from "../api";

interface RobloxVersion {
  version: string;
  date: string;
  file_version: string;
  installed: boolean;
  in_use: boolean;
}

interface VersionList {
  versions: RobloxVersion[];
  current: RobloxVersion | null;
}

interface VerifyOutcome {
  checked: number;
  repaired: string[];
  unverifiable: boolean;
  still_differs: number;
}

interface RobloxSettings {
  pinned_roblox_version: string | null;
  verify_before_launch: boolean;
  [key: string]: unknown;
}

/** The last list that was fetched: shown at once when Settings is opened again, then refreshed. */
let cachedVersions: VersionList | null = null;

/** Saves a change to the settings without touching the other fields. */
async function patchSettings(patch: Partial<RobloxSettings>): Promise<RobloxSettings> {
  const current = await invoke<RobloxSettings>("get_settings");
  const next = { ...current, ...patch };
  await invoke("update_settings", { settings: next });
  return next;
}

/** Which Roblox version Luna uses (the newest, or one that is pinned) and whether its files are checked. */
export function RobloxSection() {
  const t = useT();
  const [settings, setSettings] = useState<RobloxSettings | null>(null);
  const [list, setList] = useState<VersionList | null>(cachedVersions);
  // The version Luna has installed now (its hash), None-like when there is none yet.
  const [installed, setInstalled] = useState<string | null | undefined>(undefined);
  const [manual, setManual] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [checking, setChecking] = useState<"quick" | "deep" | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<RobloxSettings>("get_settings").then(setSettings).catch((e) => setError(String(e)));
    void loadInstalled();
    // the list is there without pressing anything, and is fetched again on every visit
    void showVersions();
    // a repair downloads files: its progress arrives here
    const un = listen<BootProgress>("bootstrap-progress", (e) => setPercent(e.payload.stage === "downloading" ? Math.floor(e.payload.percent) : null));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const pinned = settings?.pinned_roblox_version ?? null;
  const versions = list?.versions ?? null;
  const newest = versions?.[0] ?? null;
  const current = list?.current ?? null;

  async function loadInstalled() {
    try {
      setInstalled((await invoke<{ version: string | null }>("get_roblox_install")).version);
    } catch {
      setInstalled(null);
    }
  }

  // What the next launch will do about the version.
  const note = !installed
    ? installed === null
      ? t("roblox.nextFirst")
      : null
    : pinned && pinned !== installed
      ? t("roblox.nextPinned", { v: pinned })
      : !pinned && newest && newest.version !== installed
        ? t("roblox.nextNewer", { v: newest.file_version })
        : null;

  async function showVersions() {
    setLoadingList(true);
    setError(null);
    try {
      const fresh = await invoke<VersionList>("list_roblox_versions");
      cachedVersions = fresh;
      setList(fresh);
    } catch (e) {
      // an older list that is still on screen stays useful
      setError(String(e));
    } finally {
      setLoadingList(false);
    }
  }

  async function pin(version: string | null) {
    setError(null);
    setMessage(null);
    try {
      await invoke("set_roblox_pin", { version });
      setSettings(await invoke<RobloxSettings>("get_settings"));
      setPicked(null);
      setManual("");
      setMessage(version ? t("roblox.pinned") : t("roblox.unpinned"));
      void loadInstalled();
    } catch (e) {
      setError(String(e));
    }
  }

  async function setVerify(enabled: boolean) {
    setError(null);
    try {
      setSettings(await patchSettings({ verify_before_launch: enabled }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function check(deep: boolean) {
    setChecking(deep ? "deep" : "quick");
    setError(null);
    setMessage(null);
    setPercent(null);
    try {
      const r = await invoke<VerifyOutcome>("verify_roblox_files", { deep });
      if (r.unverifiable) setMessage(t("roblox.unverifiable"));
      else if (r.still_differs > 0) setMessage(t("roblox.stillDiffers", { n: r.still_differs }));
      else if (r.repaired.length > 0) setMessage(t("roblox.repaired", { n: r.repaired.length }));
      else setMessage(t("roblox.allGood", { n: r.checked.toLocaleString() }));
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(null);
      setPercent(null);
    }
  }

  return (
    <section className="appearance-block">
      <h3>{t("roblox.heading")}</h3>

      <div className={`server-card version-card ${installed ? "server-card--live" : ""}`}>
        <span className="server-card-head">{t("roblox.inUse")}</span>
        <strong className="version-card-number">
          {installed === undefined ? "…" : installed ? (current?.file_version ?? installed) : t("roblox.notInstalled")}
        </strong>
        {installed && <span className="server-meta">{[installed, current?.date].filter(Boolean).join(" · ")}</span>}
        <div className="server-chips">
          <span className={`server-chip ${pinned ? "server-chip--ok" : "server-chip--good"}`}>
            {pinned ? t("roblox.chipPinned") : t("roblox.chipAuto")}
          </span>
          {newest && installed === newest.version && <span className="server-chip">{t("roblox.tagNewest")}</span>}
        </div>
        {note && <p className="appearance-hint version-card-note">{note}</p>}
      </div>
      <p className="appearance-hint">{t("roblox.versionHint")}</p>

      <div className="appearance-row">
        <button className="apply-btn" style={{ flex: 1 }} disabled={loadingList} onClick={showVersions}>
          {loadingList ? t("common.working") : t("roblox.reload")}
        </button>
        <button className="apply-btn" style={{ flex: 1 }} disabled={!pinned} onClick={() => pin(null)}>
          {t("roblox.useNewest")}
        </button>
      </div>

      {!versions && loadingList && <p className="appearance-hint">{t("roblox.loadingList")}</p>}
      {versions && (
        <>
          <div className="version-list">
            {versions.map((v, i) => (
              <button
                key={v.version}
                className={`version-row ${picked === v.version ? "version-row--on" : ""}`}
                aria-pressed={picked === v.version}
                onClick={() => setPicked(v.version)}
              >
                <span className="version-text">
                  <span className="version-number">{v.file_version}</span>
                  <span className="version-meta">{v.date} · {v.version.slice(0, 16)}</span>
                </span>
                <span className="version-tags">
                  {i === 0 && <span className="server-chip">{t("roblox.tagNewest")}</span>}
                  {v.version === pinned && <span className="server-chip server-chip--ok">{t("roblox.tagPinned")}</span>}
                  {v.version === installed && <span className="server-chip server-chip--good">{t("roblox.tagInUse")}</span>}
                  {v.installed && v.version !== installed && <span className="server-chip server-chip--dim">{t("roblox.tagInstalled")}</span>}
                </span>
              </button>
            ))}
          </div>
          <button
            className="apply-btn apply-btn--full"
            disabled={!picked || picked === pinned}
            onClick={() => picked && pin(picked)}
          >
            {t("roblox.pin")}
          </button>
        </>
      )}

      <div className="field-column roblox-gap">
        <span className="field-label">{t("roblox.manual")}</span>
        <p className="appearance-hint">{t("roblox.manualHint")}</p>
        <div className="appearance-row">
          <input
            className="flag-input"
            style={{ flex: 1, minWidth: 0 }}
            value={manual}
            placeholder="version-0123456789abcdef"
            spellCheck={false}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && manual.trim() && void pin(manual)}
          />
          <button className="apply-btn" disabled={!manual.trim()} onClick={() => pin(manual)}>
            {t("roblox.manualUse")}
          </button>
        </div>
      </div>

      <div className="field-row roblox-gap">
        <div className="field-text">
          <span className="field-label">{t("roblox.verify")}</span>
          <p className="appearance-hint">{t("roblox.verifyHint")}</p>
        </div>
        <ToggleSwitch
          checked={settings?.verify_before_launch ?? true}
          disabled={!settings}
          label={t("roblox.verifyToggle")}
          onChange={setVerify}
        />
      </div>
      <div className="appearance-row">
        <button className="apply-btn" style={{ flex: 1 }} disabled={checking !== null} onClick={() => check(false)}>
          {checking === "quick" ? (percent !== null ? t("boot.downloading", { p: percent }) : t("common.working")) : t("roblox.checkNow")}
        </button>
        <button className="apply-btn" style={{ flex: 1 }} disabled={checking !== null} onClick={() => check(true)}>
          {checking === "deep" ? (percent !== null ? t("boot.downloading", { p: percent }) : t("common.working")) : t("roblox.checkDeep")}
        </button>
      </div>
      <StatusLine text={error ?? message} error={Boolean(error)} />
    </section>
  );
}
