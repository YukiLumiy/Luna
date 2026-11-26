import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useT, type Key } from "../i18n";
import { useArmed } from "../useArmed";
import { useOutsideDismiss } from "../useOutsideDismiss";
import { StatusLine } from "./StatusLine";

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
  /** Bumped by the parent when profiles were renamed/deleted, so what is shown is re-read. */
  syncKey?: number;
}

function baseName(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

export function AppearanceSection({ onApplied, syncKey = 0 }: AppearanceSectionProps) {
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
  const { armed: armedDelete, arm: armDelete, disarm: disarmDelete } = useArmed();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

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
    void refreshState();
  }, [loadMine, refreshState, syncKey]);

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
      const off = await invoke<string[]>("reset_appearance", { kind: "skybox" });
      setPendingSkyPaths({});
      setAppliedSkyFaces({});
      setSkyStatus(off.length ? t("sky.resetOff", { names: off.join(", ") }) : t("sky.resetDone"));
      await refreshState();
      onApplied();
    } catch (err) {
      setSkyStatus(String(err));
    } finally {
      setSkyBusy(false);
    }
  }

  async function applyPreset(preset: SkyPreset) {
    if (skyBusy) return;
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
    if (skyBusy) return;
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
      armDelete(name);
      return;
    }
    disarmDelete();
    try {
      await invoke("delete_user_sky_preset", { name });
      loadMine();
      void refreshState();
    } catch (err) {
      setSkyStatus(String(err));
    }
  }

  function startRenameMine(name: string) {
    disarmDelete();
    setRenaming(name);
    setRenameDraft(name);
  }

  /** `leave`: the person clicked elsewhere, so the mode ends even if the name was refused. */
  async function commitRenameMine(oldName: string, leave = false) {
    const next = renameDraft.trim();
    if (!next || next === oldName) {
      setRenaming(null);
      return;
    }
    try {
      const saved = await invoke<string>("rename_user_sky_preset", { oldName, newName: next });
      setRenaming(null);
      setSkyStatus(t("sky.renamed", { name: saved }));
      loadMine();
      void refreshState();
    } catch (err) {
      setSkyStatus(String(err));
      if (leave) setRenaming(null);
    }
  }

  // Clicking anywhere else ends the rename (keeping the new name if it is a valid one).
  useOutsideDismiss(renaming !== null, () => {
    if (renaming !== null) void commitRenameMine(renaming, true);
  });

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
        <StatusLine text={fontStatus} />
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
        <StatusLine text={skyStatus} reserve />

        {presets.length > 0 && (
          <div className="sky-templates">
            <button
              className="sky-templates-head"
              onClick={() => setShowTemplates((v) => !v)}
              aria-expanded={showTemplates}
            >
              <span>{t("sky.templates")}</span>
              <span className="sky-templates-count">{presets.length}</span>
              <span className={`sky-templates-chevron ${showTemplates ? "is-open" : ""}`}>▸</span>
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
                    aria-busy={skyBusy}
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
                const label = `my:${p.name}`;
                const on = p.faces.length > 0 && p.faces.every((k) => appliedSkyFaces[k] === label);
                const armed = armedDelete === p.name;
                const editing = renaming === p.name;
                return (
                  <div key={p.name} className={`sky-mine-item ${on ? "sky-mine-item--on" : ""}`}>
                    {p.thumb ? (
                      <img className="sky-mine-thumb" src={p.thumb} alt="" draggable={false} />
                    ) : (
                      <span className="sky-mine-thumb sky-mine-noimg" aria-hidden />
                    )}
                    {editing ? (
                      <input
                        className="flag-input sky-mine-rename"
                        data-editing="true"
                        value={renameDraft}
                        autoFocus
                        maxLength={40}
                        spellCheck={false}
                        aria-label={t("sky.rename", { name: p.name })}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRenameMine(p.name);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      <button
                        className="sky-mine-apply"
                        onClick={() => applyMine(p)}
                        aria-busy={skyBusy}
                        title={t("sky.mineTitle", { name: p.name })}
                      >
                        <span className="sky-mine-name">{p.name}</span>
                        {!armed && <span className="sky-mine-count">{p.faces.length}/6</span>}
                      </button>
                    )}
                    {editing ? (
                      <>
                        <button className="icon-btn" data-editing="true" aria-label={t("common.save")} title={t("common.save")} onClick={() => commitRenameMine(p.name)}>
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.2 3.2L13 4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                        <button className="icon-btn" data-editing="true" aria-label={t("common.cancel")} title={t("common.cancel")} onClick={() => setRenaming(null)}>
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                        </button>
                      </>
                    ) : (
                      <>
                        {!armed && (
                          <button className="icon-btn" aria-label={t("sky.rename", { name: p.name })} title={t("common.rename")} onClick={() => startRenameMine(p.name)}>
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10.5 3.2l2.3 2.3M2.8 13.2l.5-2.9 7.2-7.1 2.3 2.3-7.1 7.2-2.9.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /></svg>
                          </button>
                        )}
                        <button
                          className={`icon-btn ${armed ? "icon-btn--danger" : ""}`}
                          data-armed={armed}
                          onClick={() => deleteMine(p.name)}
                          title={armed ? undefined : t("sky.mineDelete", { name: p.name })}
                          aria-label={t("sky.mineDelete", { name: p.name })}
                        >
                          {armed ? (
                            <span className="icon-btn-text">{t("profiles.deleteConfirm")}</span>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                          )}
                        </button>
                      </>
                    )}
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
