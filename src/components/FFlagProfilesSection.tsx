import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { notifyFlagsChanged } from "../flagEvents";
import { useT } from "../i18n";

interface Profile {
  name: string;
  count: number;
}

/** Named snapshots of the whole flag set: save the current one, load or delete later. */
export function FFlagProfilesSection() {
  const t = useT();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    invoke<Profile[]>("list_fflag_profiles").then(setProfiles).catch((err) => setError(String(err)));
  useEffect(() => {
    refresh();
  }, []);

  async function run(cmd: string, args: Record<string, unknown>, done: string, changesFlags = false) {
    setMessage(null);
    setError(null);
    try {
      await invoke(cmd, args);
      setMessage(done);
      if (changesFlags) notifyFlagsChanged();
    } catch (err) {
      setError(String(err));
    }
    refresh();
  }

  return (
    <section className="appearance-block">
      <h3>{t("fprofiles.heading")}</h3>
      <div className="field-column">
        <p className="appearance-hint">{t("fprofiles.hint")}</p>
        <div className="appearance-row">
          <input
            className="flag-input"
            style={{ flex: 1 }}
            placeholder={t("fprofiles.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="apply-btn"
            disabled={!name.trim()}
            onClick={() => run("save_fflag_profile", { name }, t("fprofiles.saved", { name: name.trim() })).then(() => setName(""))}
          >
            {t("common.save")}
          </button>
        </div>
        {profiles.map((p) => (
          <div className="profile-row" key={p.name}>
            <span className="field-label">
              {p.name} <span className="appearance-hint">{t("fprofiles.count", { n: p.count })}</span>
            </span>
            <span className="profile-actions">
              <button className="apply-btn" onClick={() => run("load_fflag_profile", { name: p.name }, t("fprofiles.loaded", { name: p.name }), true)}>
                {t("common.load")}
              </button>
              <button className="apply-btn" onClick={() => run("delete_fflag_profile", { name: p.name }, t("fprofiles.deleted", { name: p.name }))}>
                {t("common.delete")}
              </button>
            </span>
          </div>
        ))}
        {message && <p className="appearance-hint">{message}</p>}
        {error && <p className="flag-error">{error}</p>}
      </div>
    </section>
  );
}
