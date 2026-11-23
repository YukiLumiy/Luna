import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { notifyFlagsChanged, onFlagsChanged } from "../flagEvents";
import { useT } from "../i18n";
import { useArmed } from "../useArmed";

type FlagValue = string | number | boolean;
type FlagMap = Record<string, FlagValue>;

export function FastFlagsSection() {
  const t = useT();
  const [flags, setFlags] = useState<FlagMap>({});
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The flag being edited (by its current name) and its draft.
  const [editing, setEditing] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const { armed: armedReset, arm: armReset, disarm: disarmReset } = useArmed();

  useEffect(() => {
    const load = () =>
      invoke<FlagMap>("get_fast_flags")
        .then((result) => {
          setFlags(result);
          setLoaded(true);
        })
        .catch((err) => setStatus(String(err)));
    load();
    // Presets and profiles change the same file, so reload when they do.
    return onFlagsChanged(load);
  }, []);

  async function persist(next: FlagMap) {
    setFlags(next);
    try {
      await invoke("save_fast_flags", { flags: next });
      setStatus(null);
      notifyFlagsChanged();
    } catch (err) {
      setStatus(String(err));
    }
  }

  function parseValue(raw: string): FlagValue {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
    return raw;
  }

  function addFlag() {
    const key = newKey.trim();
    if (!key) return;
    persist({ ...flags, [key]: parseValue(newValue.trim()) });
    setNewKey("");
    setNewValue("");
  }

  function removeFlag(key: string) {
    const next = { ...flags };
    delete next[key];
    persist(next);
  }

  /** Clears every flag (two clicks: the first asks "Delete all N flags?"). */
  function resetAll() {
    if (armedReset === null) return armReset("all");
    disarmReset();
    setEditing(null);
    void persist({});
    setStatus(null);
  }

  function startEdit(key: string) {
    setEditing(key);
    setDraftKey(key);
    setDraftValue(String(flags[key]));
    setStatus(null);
  }

  function cancelEdit() {
    setEditing(null);
  }

  /** Saves in place, so a renamed flag keeps its position in the list. */
  function saveEdit() {
    if (editing === null) return;
    const key = draftKey.trim();
    if (!key) {
      setStatus(t("flags.needName"));
      return;
    }
    if (key !== editing && key in flags) {
      setStatus(t("flags.exists", { key }));
      return;
    }
    const next: FlagMap = {};
    for (const [k, v] of Object.entries(flags)) {
      if (k === editing) next[key] = parseValue(draftValue.trim());
      else next[k] = v;
    }
    setEditing(null);
    void persist(next);
  }

  const entries = Object.entries(flags);

  return (
    <section className="appearance-block">
      <h3>{t("flags.heading")}</h3>
      <p className="appearance-hint">
        {t("flags.hint")}
      </p>

      {status && <p className="flag-error">{status}</p>}

      {!loaded && <p className="appearance-hint">{t("common.loading")}</p>}
      {loaded && entries.length === 0 && (
        <p className="appearance-hint">{t("flags.none")}</p>
      )}

      {entries.length > 0 && (
        <ul className="flag-list">
          {entries.map(([key, value]) => (
            <li key={key} className={`flag-row ${editing === key ? "flag-row--editing" : ""}`}>
              {editing === key ? (
                <>
                  <div className="flag-edit-fields">
                    <input
                      className="flag-input"
                      value={draftKey}
                      autoFocus
                      spellCheck={false}
                      aria-label={t("flags.nameLabel")}
                      onChange={(e) => setDraftKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                    />
                    <input
                      className="flag-input"
                      value={draftValue}
                      spellCheck={false}
                      aria-label={t("flags.valueLabel")}
                      onChange={(e) => setDraftValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                    />
                  </div>
                  <button className="flag-icon" aria-label={t("common.save")} title={t("common.save")} onClick={saveEdit}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.2 3.2L13 4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                  <button className="flag-icon" aria-label={t("common.cancel")} title={t("common.cancel")} onClick={cancelEdit}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                  </button>
                </>
              ) : (
                <>
                  <span className="flag-key" title={key}>{key}</span>
                  <span className="flag-value" title={String(value)}>{String(value)}</span>
                  <button className="flag-icon" aria-label={t("flags.edit", { key })} title={t("common.edit")} onClick={() => startEdit(key)}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10.5 3.2l2.3 2.3M2.8 13.2l.5-2.9 7.2-7.1 2.3 2.3-7.1 7.2-2.9.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" /></svg>
                  </button>
                  <button
                    className="flag-remove"
                    aria-label={t("flags.remove", { key })}
                    onClick={() => removeFlag(key)}
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {entries.length > 0 && (
        <button
          className={`reset-btn flag-reset-all ${armedReset ? "reset-btn--danger" : ""}`}
          data-armed={armedReset !== null}
          onClick={resetAll}
        >
          {armedReset ? t("flags.resetConfirm", { n: entries.length }) : t("flags.resetAll")}
        </button>
      )}

      <div className="flag-add-row">
        <input
          className="flag-input flag-input--key"
          placeholder="FFlagSomeName"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <div className="flag-add-row-bottom">
          <input
            className="flag-input flag-input--value"
            placeholder="True"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addFlag()}
          />
          <button className="apply-btn" onClick={addFlag} disabled={!newKey.trim()}>
            {t("common.add")}
          </button>
        </div>
      </div>

    </section>
  );
}
