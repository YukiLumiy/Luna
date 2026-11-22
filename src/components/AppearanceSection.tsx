import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useT, type Key } from "../i18n";

type FaceKey = "up" | "dn" | "ft" | "bk" | "lf" | "rt";

// Labels and hints live in the locale files as sky.face.<key> and sky.face.<key>.hint.
const SKY_FACES: { key: FaceKey; area: string }[] = [
  { key: "up", area: "up" },
  { key: "lf", area: "lf" },
  { key: "ft", area: "ft" },
  { key: "rt", area: "rt" },
  { key: "bk", area: "bk" },
  { key: "dn", area: "dn" },
];

/** What is really applied, worked out from the files on disk. */
interface AppearanceState {
  font: string | null;
  sky_faces: Record<string, string>;
}

interface SkyPreset {
  slug: string;
  name: string;
}

// Thumbnails of the built-in templates, bundled with the app.
const presetThumbs = import.meta.glob("../assets/sky-presets/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function thumbFor(slug: string) {
  return presetThumbs[`../assets/sky-presets/${slug}.jpg`];
}

interface UserSkyPreset {
  name: string;
  faces: string[];
  thumb: string | null;
}

interface AppearanceSectionProps {
  onApplied: () => void;
}

function baseName(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

export function AppearanceSection({ onApplied }: AppearanceSectionProps) {
  const t = useT();
  // What's already applied, per Luna's saved settings — shown until the
  // person picks something new.
  const [appliedFontName, setAppliedFontName] = useState<string | null>(null);
  const [appliedSkyFaces, setAppliedSkyFaces] = useState<Record<string, string>>({});

  // A new selection awaiting "Apply".
  const [pendingFontPath, setPendingFontPath] = useState<string | null>(null);
  const [pendingSkyPaths, setPendingSkyPaths] = useState<Record<string, string>>({});

  const [fontStatus, setFontStatus] = useState<string | null>(null);
  const [fontBusy, setFontBusy] = useState(false);
  const [skyStatus, setSkyStatus] = useState<string | null>(null);
  const [skyBusy, setSkyBusy] = useState(false);

  const [presets, setPresets] = useState<SkyPreset[]>([]);
  const [showTemplates, setShowTemplates] = useState(true);
  // The template the pointer (or keyboard focus) last touched. It is cleared only when the
  // pointer/focus leaves the whole grid, so the gap between two thumbnails changes nothing.
  const [hotSlug, setHotSlug] = useState<string | null>(null);

  // Skyboxes the person saved themselves.
  const [mine, setMine] = useState<UserSkyPreset[]>([]);
  const [mineName, setMineName] = useState("");
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  // "Applied" is read from the files, not from a remembered name, so it
  // drops back by itself when the profile is switched off, deleted or
  // reset elsewhere. Checked often and whenever the window regains focus.
  const refreshState = useCallback(async () => {
    try {
      const s = await invoke<AppearanceState>("get_appearance_state");
      setAppliedFontName(s.font);
      setAppliedSkyFaces(s.sky_faces ?? {});
    } catch {
      // keep what is shown
    }
  }, []);

  useEffect(() => {
    void refreshState();
    const timer = window.setInterval(refreshState, 2000);
    window.addEventListener("focus", refreshState);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshState);
    };
  }, [refreshState]);

  const loadMine = useCallback(() => {
    invoke<UserSkyPreset[]>("list_user_sky_presets").then(setMine).catch(() => undefined);
  }, []);
  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    invoke<SkyPreset[]>("list_sky_presets").then(setPresets).catch(() => undefined);
  }, []);

  async function pickFont() {
    const selected = await open({
      multiple: false,
      filters: [{ name: t("common.fontFilter"), extensions: ["otf", "ttf"] }],
    });
    if (typeof selected === "string") {
      setPendingFontPath(selected);
      setFontStatus(null);
    }
  }

  async function applyFont() {
    if (!pendingFontPath) return;
    setFontBusy(true);
    setFontStatus(null);
    try {
      const count = await invoke<number>("install_font_mod", {
        profileName: "custom-font",
        fontPath: pendingFontPath,
      });
      setAppliedFontName(baseName(pendingFontPath));
      setPendingFontPath(null);
      setFontStatus(t("font.applied", { n: count }));
      void refreshState();
      onApplied();
    } catch (err) {
      setFontStatus(String(err));
    } finally {
      setFontBusy(false);
    }
  }

  async function pickSkyFace(key: FaceKey) {
    const selected = await open({
      multiple: false,
      filters: [{ name: t("common.imageFilter"), extensions: ["png", "jpg", "jpeg", "tex"] }],
    });
    if (typeof selected === "string") {
      setPendingSkyPaths((prev) => ({ ...prev, [key]: selected }));
      setSkyStatus(null);
    }
  }

  async function applySkybox() {
    setSkyBusy(true);
    setSkyStatus(null);
    try {
      const count = await invoke<number>("install_skybox_mod", {
        profileName: "custom-skybox",
        faces: {
          ft: pendingSkyPaths.ft ?? null,
          bk: pendingSkyPaths.bk ?? null,
          lf: pendingSkyPaths.lf ?? null,
          rt: pendingSkyPaths.rt ?? null,
          up: pendingSkyPaths.up ?? null,
          dn: pendingSkyPaths.dn ?? null,
        },
      });
      setAppliedSkyFaces((prev) => {
        const next = { ...prev };
        for (const [key, path] of Object.entries(pendingSkyPaths)) {
          next[key] = baseName(path);
        }
        return next;
      });
      setPendingSkyPaths({});
      setSkyStatus(t(count === 1 ? "sky.appliedOne" : "sky.appliedMany", { n: count }));
      void refreshState();
      onApplied();
    } catch (err) {
      setSkyStatus(String(err));
    } finally {
      setSkyBusy(false);
    }
  }

  async function resetFont() {
    setFontBusy(true);
    try {
      await invoke("reset_appearance", { kind: "font" });
      setPendingFontPath(null);
      setAppliedFontName(null);
      setFontStatus(t("font.resetDone"));
      onApplied();
    } catch (err) {
      setFontStatus(String(err));
    } finally {
      setFontBusy(false);
    }
  }

  async function resetSkybox() {
    setSkyBusy(true);
    try {
      await invoke("reset_appearance", { kind: "skybox" });
      setPendingSkyPaths({});
      setAppliedSkyFaces({});
      setSkyStatus(t("sky.resetDone"));
      onApplied();
    } catch (err) {
      setSkyStatus(String(err));
    } finally {
      setSkyBusy(false);
    }
  }

  async function applyPreset(preset: SkyPreset) {
    setSkyBusy(true);
    setSkyStatus(null);
    try {
      await invoke("install_sky_preset", { slug: preset.slug });
      setPendingSkyPaths({});
      setSkyStatus(t("sky.templateApplied", { name: preset.name }));
      await refreshState();
      onApplied();
    } catch (err) {
      setSkyStatus(String(err));
    } finally {
      setSkyBusy(false);
    }
  }

  async function saveMine() {
    const name = mineName.trim();
    if (!name) return;
    setSkyBusy(true);
    setSkyStatus(null);
    try {
      const saved = await invoke<string>("save_user_sky_preset", { name, faces: pendingSkyPaths });
      setMineName("");
      setSkyStatus(t("sky.savedDone", { name: saved }));
      loadMine();
    } catch (err) {
      setSkyStatus(String(err));
    } finally {
      setSkyBusy(false);
    }
  }

  async function applyMine(p: UserSkyPreset) {
    setSkyBusy(true);
    setSkyStatus(null);
    try {
      await invoke("apply_user_sky_preset", { name: p.name });
      setPendingSkyPaths({});
      setSkyStatus(t("sky.mineApplied", { name: p.name }));
      await refreshState();
      onApplied();
    } catch (err) {
      setSkyStatus(String(err));
    } finally {
      setSkyBusy(false);
    }
  }

  async function deleteMine(name: string) {
    if (armedDelete !== name) {
      setArmedDelete(name);
      window.setTimeout(() => setArmedDelete((cur) => (cur === name ? null : cur)), 3000);
      return;
    }
    setArmedDelete(null);
    try {
      await invoke("delete_user_sky_preset", { name });
      loadMine();
    } catch (err) {
      setSkyStatus(String(err));
    }
  }

  // A template is "active" while all six faces still carry its name.
  const activePreset = presets.find((p) =>
    SKY_FACES.every(({ key }) => appliedSkyFaces[key] === p.name),
  );
  const anySkyApplied = Object.keys(appliedSkyFaces).length > 0;
  const anySkyPending = Object.keys(pendingSkyPaths).length > 0;

  const fontDisplay = pendingFontPath
    ? baseName(pendingFontPath)
    : appliedFontName
      ? appliedFontName
      : t("font.choose");

  return (
    <div className="appearance">
      <section className="appearance-block">
        <h3>{t("font.heading")}</h3>
        <p className="appearance-hint">
          {t("font.hint")}
        </p>
        <div className="appearance-row">
          <button className="picker-btn" onClick={pickFont} title={fontDisplay}>
            <span className="picker-btn-text">{fontDisplay}</span>
            {appliedFontName && !pendingFontPath && (
              <span className="picker-btn-tag">{t("font.active")}</span>
            )}
          </button>
          <button
            className="apply-btn"
            onClick={applyFont}
            disabled={!pendingFontPath || fontBusy}
          >
            {fontBusy ? t("common.working") : t("common.apply")}
          </button>
          <button
            className="reset-btn"
            onClick={resetFont}
            disabled={(!appliedFontName && !pendingFontPath) || fontBusy}
            title={t("font.resetTitle")}
          >
            {t("common.reset")}
          </button>
        </div>
        {fontStatus && <p className="appearance-status">{fontStatus}</p>}
      </section>

      <section className="appearance-block">
        <h3>{t("sky.heading")}</h3>
        <p className="appearance-hint">
          {t("sky.hint")}
        </p>
        <div className="sky-net">
          {SKY_FACES.map(({ key, area }) => {
            const label = t(`sky.face.${key}` as Key);
            const hint = t(`sky.face.${key}.hint` as Key);
            const applied = appliedSkyFaces[key];
            const pending = pendingSkyPaths[key];
            return (
              <button
                key={key}
                className={`sky-face-btn ${pending || applied ? "sky-face-btn--set" : ""}`}
                style={{ gridArea: area }}
                onClick={() => pickSkyFace(key)}
                title={hint}
              >
                <span className="sky-face-label">{label}</span>
                <span className="sky-face-code">{key}</span>
                {(pending || applied) && <span className="sky-face-check">✓</span>}
              </button>
            );
          })}
        </div>
        <div className="sky-actions">
          <button
            className="apply-btn"
            onClick={applySkybox}
            disabled={!anySkyPending || skyBusy}
          >
            {skyBusy ? t("common.working") : t("sky.apply")}
          </button>
          <button
            className="reset-btn"
            onClick={resetSkybox}
            disabled={(!anySkyApplied && !anySkyPending) || skyBusy}
            title={t("sky.resetTitle")}
          >
            {t("common.reset")}
          </button>
        </div>
        {skyStatus && <p className="appearance-status">{skyStatus}</p>}

        {presets.length > 0 && (
          <div className="sky-templates">
            <button
              className="sky-templates-head"
              onClick={() => setShowTemplates((v) => !v)}
              aria-expanded={showTemplates}
            >
              <span>{t("sky.templates")}</span>
              <span className="sky-templates-count">{presets.length}</span>
              <span className="sky-templates-chevron">{showTemplates ? "▾" : "▸"}</span>
            </button>
            {showTemplates && (
              <div
                className="sky-templates-grid"
                onPointerLeave={() => setHotSlug(null)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHotSlug(null);
                }}
              >
                {presets.map((p) => (
                  <button
                    key={p.slug}
                    className={`sky-template ${activePreset?.slug === p.slug ? "sky-template--on" : ""} ${
                      hotSlug === null ? "" : hotSlug === p.slug ? "sky-template--hot" : "sky-template--dim"
                    }`}
                    onPointerEnter={() => setHotSlug(p.slug)}
                    onFocus={() => setHotSlug(p.slug)}
                    onClick={() => applyPreset(p)}
                    disabled={skyBusy}
                    title={t("sky.templateTitle", { name: p.name })}
                  >
                    <img src={thumbFor(p.slug)} alt="" draggable={false} />
                    <span>{p.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="sky-mine">
          <h4 className="sky-mine-title">{t("sky.mine")}</h4>
          <p className="appearance-hint">{t("sky.mineHint")}</p>
          <div className="appearance-row">
            <input
              className="flag-input"
              style={{ flex: 1 }}
              placeholder={t("sky.saveName")}
              value={mineName}
              maxLength={40}
              onChange={(e) => setMineName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveMine();
              }}
            />
            <button
              className="apply-btn"
              onClick={saveMine}
              disabled={skyBusy || !mineName.trim() || (!anySkyPending && !anySkyApplied)}
            >
              {t("common.save")}
            </button>
          </div>
          {mine.length === 0 ? (
            <p className="appearance-hint sky-mine-empty">{t("sky.mineEmpty")}</p>
          ) : (
            <div className="sky-mine-list">
              {mine.map((p) => {
                const on = p.faces.length > 0 && p.faces.every((k) => appliedSkyFaces[k] === p.name);
                return (
                  <div key={p.name} className={`sky-mine-item ${on ? "sky-mine-item--on" : ""}`}>
                    <button
                      className="sky-mine-apply"
                      onClick={() => applyMine(p)}
                      disabled={skyBusy}
                      title={t("sky.mineTitle", { name: p.name })}
                    >
                      {p.thumb ? (
                        <img src={p.thumb} alt="" draggable={false} />
                      ) : (
                        <span className="sky-mine-noimg" aria-hidden />
                      )}
                      <span className="sky-mine-name">{p.name}</span>
                      <span className="sky-mine-count">{p.faces.length}/6</span>
                    </button>
                    <button
                      className={`icon-btn ${armedDelete === p.name ? "icon-btn--danger" : ""}`}
                      onClick={() => deleteMine(p.name)}
                      title={t("sky.mineDelete", { name: p.name })}
                      aria-label={t("sky.mineDelete", { name: p.name })}
                    >
                      {armedDelete === p.name ? (
                        <span className="icon-btn-text">{t("profiles.deleteConfirm")}</span>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

    </div>
  );
}
