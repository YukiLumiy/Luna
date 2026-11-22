import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToggleSwitch } from "./ToggleSwitch";
import { tx, useT } from "../i18n";
import { PRESETS, type Flags, type Preset } from "../fflagPresets";
import { notifyFlagsChanged, onFlagsChanged } from "../flagEvents";

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const matches = (flags: Flags, want: Flags) =>
  Object.entries(want).every(([key, value]) => key in flags && same(flags[key], value));

/** One-tap switches and choices for the flags people change most. */
export function FFlagPresetsSection() {
  const t = useT();
  const [flags, setFlags] = useState<Flags>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      invoke<Flags>("get_fast_flags").then(setFlags).catch((err) => setError(String(err)));
    load();
    return onFlagsChanged(load);
  }, []);

  async function change(set: Flags, remove: string[]) {
    try {
      setFlags(await invoke<Flags>("update_fast_flags", { set, remove }));
      setError(null);
      notifyFlagsChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  function control(p: Preset) {
    if (p.kind === "toggle") {
      return (
        <ToggleSwitch
          checked={matches(flags, p.flags)}
          label={t("common.toggle", { label: tx(p.label) })}
          onChange={(on) => change(on ? p.flags : {}, on ? [] : Object.keys(p.flags))}
        />
      );
    }
    const group = Array.from(new Set(p.options.flatMap((o) => Object.keys(o.flags))));
    const active =
      p.options.find((o) => Object.keys(o.flags).length > 0 && matches(flags, o.flags)) ??
      (group.every((k) => !(k in flags)) ? p.options[0] : undefined);
    return (
      <div className="preset-chips">
        {p.options.map((o) => (
          <button
            key={o.label}
            className={`preset-chip ${active === o ? "preset-chip--on" : ""}`}
            onClick={() => change(o.flags, group.filter((k) => !(k in o.flags)))}
          >
            {tx(o.label)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <section className="appearance-block">
      <h3>{t("presets.heading")}</h3>
      {PRESETS.map((p) =>
        p.kind === "toggle" ? (
          <div className="field-row" key={p.id}>
            <div className="field-text">
              <span className="field-label">{tx(p.label)}</span>
              <p className="appearance-hint">{tx(p.hint)}</p>
            </div>
            {control(p)}
          </div>
        ) : (
          <div className="field-column" key={p.id}>
            <span className="field-label">{tx(p.label)}</span>
            <p className="appearance-hint">{tx(p.hint)}</p>
            {control(p)}
          </div>
        ),
      )}
      {error && <p className="flag-error">{error}</p>}
    </section>
  );
}
