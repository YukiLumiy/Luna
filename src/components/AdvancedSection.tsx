import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToggleSwitch } from "./ToggleSwitch";
import { getLang, setLang, useT, type Key } from "../i18n";
import { applyTheme, normalizeTheme, type ThemeId } from "../theme";
import { PALETTES, applyPalette, savedPalette, type PaletteId } from "../palettes";
import type { CSSProperties } from "react";

const THEME_TILES: { id: ThemeId; label: Key }[] = [
  { id: "dark", label: "adv.dark" },
  { id: "light", label: "adv.light" },
];

interface LunaSettings {
  release_channel: string | null;
  discord_rpc_enabled: boolean;
  theme: string;
  clear_cache_on_launch: boolean;
  clear_cache_on_exit: boolean;
  hide_window_on_launch: boolean;
  game_popup: boolean;
  brand_roblox_window: boolean;
}

interface CacheClearResult {
  removed: number;
  bytes_freed: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Shown until the saved settings arrive, so the card has its final size from the first frame. */
const DEFAULTS: LunaSettings = {
  release_channel: null,
  discord_rpc_enabled: false,
  theme: document.documentElement.getAttribute("data-theme") ?? "dark",
  clear_cache_on_launch: false,
  clear_cache_on_exit: false,
  hide_window_on_launch: true,
  game_popup: true,
  brand_roblox_window: true,
};

export function AdvancedSection() {
  const t = useT();
  const [settings, setSettings] = useState<LunaSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [palette, setPalette] = useState<PaletteId>(savedPalette());
  const [channelInput, setChannelInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  useEffect(() => {
    invoke<LunaSettings>("get_settings").then((s) => {
      // A retired theme name (Liquid Glass) is shown as its plain counterpart.
      setSettings({ ...s, theme: normalizeTheme(s.theme) });
      setChannelInput(s.release_channel ?? "");
      setLoaded(true);
    }).catch((err) => setStatus(String(err)));
  }, []);

  // Applies only the changed fields on top of the *latest* settings from the
  // backend. Other sections (e.g. the Asset replacer toggle) save settings
  // too, so writing back this component's older copy would silently undo them.
  async function persist(patch: Partial<LunaSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    try {
      const latest = await invoke<LunaSettings>("get_settings");
      await invoke("update_settings", { settings: { ...latest, ...patch } });
      setStatus(null);
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function clearCacheNow() {
    setCacheBusy(true);
    setCacheMessage(null);
    setCacheError(null);
    try {
      const result = await invoke<CacheClearResult>("clear_roblox_cache");
      setCacheMessage(
        result.removed === 0
          ? t("adv.cacheEmpty")
          : t("adv.cacheCleared", { size: formatBytes(result.bytes_freed) }),
      );
    } catch (err) {
      setCacheError(String(err));
    } finally {
      setCacheBusy(false);
    }
  }

  return (
    <section className="appearance-block">
      <h3>{t("adv.heading")}</h3>

      <div className="field-row field-row--stack">
        <div className="field-text">
          <span className="field-label">{t("adv.theme")}</span>
          <p className="appearance-hint">{t("adv.themeHint")}</p>
        </div>
        <div className="theme-grid" role="radiogroup" aria-label={t("adv.theme")}>
          {THEME_TILES.map(({ id, label }) => (
            <button
              key={id}
              role="radio"
              aria-checked={settings.theme === id}
              disabled={!loaded}
              className={`theme-tile ${settings.theme === id ? "theme-tile--active" : ""}`}
              onClick={() => {
                applyTheme(id);
                persist({ theme: id });
              }}
            >
              <span className="theme-tile-swatch" data-swatch={id} />
              <span className="theme-tile-name">{t(label)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="field-row field-row--stack">
        <div className="field-text">
          <span className="field-label">{t("adv.palette")}</span>
          <p className="appearance-hint">{t("adv.paletteHint")}</p>
        </div>
        <div className="palette-grid" role="radiogroup" aria-label={t("adv.palette")}>
          {PALETTES.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={palette === p.id}
              className={`palette-tile ${palette === p.id ? "palette-tile--active" : ""}`}
              onClick={() => {
                setPalette(p.id);
                applyPalette(p.id);
              }}
            >
              <span
                className="palette-swatch"
                style={{ "--p-dark": p.dark, "--p-light": p.light, "--p-accent": p.accent, "--p-light-accent": p.lightAccent } as CSSProperties}
              />
              <span className="palette-name">{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("adv.language")}</span>
          <p className="appearance-hint">{t("adv.languageHint")}</p>
        </div>
        <div className="theme-switch" data-active={getLang()}>
          <button className={`theme-option ${getLang() === "en" ? "theme-option--active" : ""}`} onClick={() => setLang("en")}>
            English
          </button>
          <button className={`theme-option ${getLang() === "ko" ? "theme-option--active" : ""}`} onClick={() => setLang("ko")}>
            한국어
          </button>
        </div>
      </div>

      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("adv.discord")}</span>
          <p className="appearance-hint">
            {t("adv.discordHint")}
          </p>
        </div>
        <ToggleSwitch
          checked={settings.discord_rpc_enabled}
          disabled={!loaded}
          label={t("adv.discordToggle")}
          onChange={(enabled) => persist({ discord_rpc_enabled: enabled })}
        />
      </div>

      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("adv.hideOnLaunch")}</span>
          <p className="appearance-hint">{t("adv.hideOnLaunchHint")}</p>
        </div>
        <ToggleSwitch
          checked={settings.hide_window_on_launch}
          disabled={!loaded}
          label={t("adv.hideOnLaunchToggle")}
          onChange={(enabled) => persist({ hide_window_on_launch: enabled })}
        />
      </div>

      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("adv.brandWindow")}</span>
          <p className="appearance-hint">{t("adv.brandWindowHint")}</p>
        </div>
        <ToggleSwitch
          checked={settings.brand_roblox_window}
          disabled={!loaded}
          label={t("adv.brandWindowToggle")}
          onChange={(enabled) => persist({ brand_roblox_window: enabled })}
        />
      </div>

      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("adv.gamePopup")}</span>
          <p className="appearance-hint">{t("adv.gamePopupHint")}</p>
        </div>
        <ToggleSwitch
          checked={settings.game_popup}
          disabled={!loaded}
          label={t("adv.gamePopupToggle")}
          onChange={(enabled) => persist({ game_popup: enabled })}
        />
      </div>

      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("adv.cacheLaunch")}</span>
          <p className="appearance-hint">
            {t("adv.cacheLaunchHint")}
          </p>
        </div>
        <ToggleSwitch
          checked={settings.clear_cache_on_launch}
          disabled={!loaded}
          label={t("adv.cacheLaunchToggle")}
          onChange={(enabled) => persist({ clear_cache_on_launch: enabled })}
        />
      </div>

      <div className="field-row">
        <div className="field-text">
          <span className="field-label">{t("adv.cacheExit")}</span>
          <p className="appearance-hint">
            {t("adv.cacheExitHint")}
          </p>
        </div>
        <ToggleSwitch
          checked={settings.clear_cache_on_exit}
          disabled={!loaded}
          label={t("adv.cacheExitToggle")}
          onChange={(enabled) => persist({ clear_cache_on_exit: enabled })}
        />
      </div>

      <div className="field-column">
        <button
          className="apply-btn apply-btn--full"
          onClick={clearCacheNow}
          disabled={cacheBusy}
        >
          {cacheBusy ? t("adv.cacheClearing") : t("adv.cacheNow")}
        </button>
        {cacheMessage && <p className="appearance-hint">{cacheMessage}</p>}
        {cacheError && <p className="flag-error">{cacheError}</p>}
      </div>

      <div className="field-column">
        <span className="field-label">{t("adv.channel")}</span>
        <p className="appearance-hint">
          {t("adv.channelHint")}
        </p>
        <div className="appearance-row">
          <input
            className="flag-input"
            style={{ flex: 1 }}
            placeholder={t("adv.channelPlaceholder")}
            value={channelInput}
            onChange={(e) => setChannelInput(e.target.value)}
          />
          <button
            className="apply-btn"
            onClick={() =>
              persist({ release_channel: channelInput.trim() || null })
            }
          >
            {t("common.save")}
          </button>
        </div>
      </div>

      {status && <p className="flag-error">{status}</p>}

      <p className="appearance-hint appearance-hint--muted">
        {t("adv.multiInstance")}
      </p>

    </section>
  );
}
