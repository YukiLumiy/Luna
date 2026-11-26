import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToggleSwitch } from "./ToggleSwitch";
import { useT } from "../i18n";
import { AppearanceSection } from "./AppearanceSection";
import { FastFlagsSection } from "./FastFlagsSection";
import { RecacheSection } from "./RecacheSection";
import { UpdateSection } from "./UpdateSection";
import { FFlagPresetsSection } from "./FFlagPresetsSection";
import { FFlagProfilesSection } from "./FFlagProfilesSection";
import { ServerSection } from "./ServerSection";
import { AdvancedSection } from "./AdvancedSection";
import { useArmed } from "../useArmed";
import { useOutsideDismiss } from "../useOutsideDismiss";

interface ModProfileInfo {
  name: string;
  enabled: boolean;
  file_count: number;
}

interface SettingsScreenProps {
  onBack: () => void;
  onProfilesChanged?: () => void;
}

export function SettingsScreen({ onBack, onProfilesChanged }: SettingsScreenProps) {
  const t = useT();
  const [profiles, setProfiles] = useState<ModProfileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Which row is being renamed / is waiting for a second click to delete.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { armed, arm, disarm } = useArmed();
  // Tells the Appearance block to re-read what is applied after a profile was deleted or
  // renamed. (It used to be remounted, which replayed its entrance animation: a visible jolt.)
  const [appearanceKey, setAppearanceKey] = useState(0);

  async function refresh() {
    try {
      const result = await invoke<ModProfileInfo[]>("list_mod_profiles");
      setProfiles(result);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleToggle(name: string, enabled: boolean) {
    setPending(name);
    try {
      await invoke("set_mod_profile_enabled", { name, enabled });
      await refresh();
      onProfilesChanged?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(null);
    }
  }

  function startRename(name: string) {
    setRenaming(name);
    setDraft(name);
    disarm();
    setError(null);
  }

  async function commitRename(oldName: string, leave = false) {
    if (draft.trim() === oldName || (leave && !draft.trim())) {
      setRenaming(null);
      return;
    }
    setPending(oldName);
    try {
      await invoke("rename_mod_profile", { oldName, newName: draft });
      setRenaming(null);
      setError(null);
      await refresh();
      setAppearanceKey((k) => k + 1);
    } catch (err) {
      setError(String(err));
      if (leave) setRenaming(null);
    } finally {
      setPending(null);
    }
  }

  // Clicking anywhere else ends the rename (keeping the new name if it is a valid one).
  useOutsideDismiss(renaming !== null, () => {
    if (renaming !== null) void commitRename(renaming, true);
  });

  async function handleDelete(name: string) {
    if (armed !== name) {
      arm(name);
      return;
    }
    disarm();
    setPending(name);
    try {
      await invoke("delete_mod_profile", { name });
      setError(null);
      await refresh();
      onProfilesChanged?.();
      setAppearanceKey((k) => k + 1);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="settings">
      <div className="settings-header">
        <button className="back-btn" onClick={onBack} aria-label={t("common.back")}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 3L5 8l5 5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h2>{t("settings.title")}</h2>
      </div>

      <AppearanceSection syncKey={appearanceKey} onApplied={refresh} />
      <UpdateSection />
      <RecacheSection />
      <FFlagPresetsSection />
      <FastFlagsSection />
      <FFlagProfilesSection />
      <ServerSection />
      <AdvancedSection />

      <div className="profiles-heading-row">
        <h3 className="section-label">{t("profiles.heading")}</h3>
        <button className="open-folder-btn" onClick={() => invoke("open_mods_folder")}>
          {t("profiles.openFolder")}
        </button>
      </div>

      {error && <p className="settings-error">{error}</p>}

      {profiles === null && !error && (
        <p className="settings-empty">{t("common.loading")}</p>
      )}

      {profiles?.length === 0 && (
        <p className="settings-empty">
          {t("profiles.emptyBefore")}<code>mods/</code>{t("profiles.emptyAfter")}
        </p>
      )}

      <ul className="profile-list">
        {profiles?.map((profile, i) => (
          <li
            key={profile.name}
            className="profile-row"
            style={{ animationDelay: `${i * 45}ms` }}
          >
            <div className="profile-info">
              {renaming === profile.name ? (
                <input
                  className="profile-rename"
                  data-editing="true"
                  value={draft}
                  autoFocus
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(profile.name);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span className="profile-name" title={profile.name}>{profile.name}</span>
              )}
              <span className="profile-meta">{t("profiles.files", { n: profile.file_count })}</span>
            </div>
            <div className="profile-actions">
              {renaming === profile.name ? (
                <>
                  <button className="icon-btn" data-editing="true" aria-label={t("profiles.saveName")} title={t("common.save")} onClick={() => commitRename(profile.name)} disabled={pending === profile.name}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.2 3.2L13 4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                  <button className="icon-btn" data-editing="true" aria-label={t("common.cancel")} title={t("common.cancel")} onClick={() => setRenaming(null)}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                  </button>
                </>
              ) : (
                <>
                  <button className="icon-btn" aria-label={t("profiles.rename", { name: profile.name })} title={t("common.rename")} onClick={() => startRename(profile.name)} disabled={pending === profile.name}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10.5 3.2l2.3 2.3M2.8 13.2l.5-2.9 7.2-7.1 2.3 2.3-7.1 7.2-2.9.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /></svg>
                  </button>
                  <button
                    className={`icon-btn ${armed === profile.name ? "icon-btn--danger" : ""}`}
                    data-armed={armed === profile.name}
                    aria-label={t("profiles.delete", { name: profile.name })}
                    title={armed === profile.name ? undefined : t("common.delete")}
                    onClick={() => handleDelete(profile.name)}
                    disabled={pending === profile.name}
                  >
                    {armed === profile.name ? (
                      <span className="icon-btn-text">{t("profiles.deleteConfirm")}</span>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v3.8M9.2 7v3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    )}
                  </button>
                </>
              )}
              <ToggleSwitch
                checked={profile.enabled}
                disabled={pending === profile.name || renaming === profile.name}
                label={t("profiles.toggle", { name: profile.name })}
                onChange={(next) => handleToggle(profile.name, next)}
              />
            </div>
          </li>
        ))}
      </ul>

    </div>
  );
}
