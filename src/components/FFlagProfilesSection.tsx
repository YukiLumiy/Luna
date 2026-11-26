import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { notifyFlagsChanged } from "../flagEvents";
import { StatusLine } from "./StatusLine";
import { useT } from "../i18n";
import { useArmed } from "../useArmed";

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
  const { armed, arm, disarm } = useArmed();

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
        {profiles.length > 0 && (
          <ul className="fprofile-list">
            {profiles.map((p) => (
              <li className="fprofile-row" key={p.name}>
                <span className="fprofile-name" title={p.name}>
                  <span className="fprofile-label">{p.name}</span>
                  <span className="fprofile-count">{t("fprofiles.count", { n: p.count })}</span>
                </span>
                <span className="fprofile-actions">
                  <button className="apply-btn" onClick={() => run("load_fflag_profile", { name: p.name }, t("fprofiles.loaded", { name: p.name }), true)}>
                    {t("common.load")}
                  </button>
                  <button
                    className={`apply-btn ${armed === p.name ? "apply-btn--danger" : ""}`}
                    data-armed={armed === p.name}
                    onClick={() => {
                      if (armed !== p.name) return arm(p.name);
                      disarm();
                      void run("delete_fflag_profile", { name: p.name }, t("fprofiles.deleted", { name: p.name }));
                    }}
                  >
                    <span key={armed === p.name ? "confirm" : "delete"} className="swap-label">
                      {armed === p.name ? t("profiles.deleteConfirm") : t("common.delete")}
                    </span>
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <StatusLine text={error ?? message} error={Boolean(error)} />
      </div>
    </section>
  );
}
