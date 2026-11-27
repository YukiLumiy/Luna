import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useT } from "../i18n";
import { useArmed } from "../useArmed";
import { StatusLine } from "./StatusLine";

interface ServerInfo {
  game: string;
  place_id: number | null;
  job_id: string | null;
  ip: string | null;
  place: string | null;
  ping_ms: number | null;
  players: number | null;
  max_players: number | null;
  playing: number | null;
  joined_at: number;
  in_game: boolean;
}

interface ServerStatus {
  current: ServerInfo | null;
  history: ServerInfo[];
}

/** A link that opens this very server in Roblox (pasted into a browser). */
function joinLink(s: ServerInfo): string {
  const base = `roblox://experiences/start?placeId=${s.place_id ?? ""}`;
  return s.job_id ? `${base}&gameInstanceId=${s.job_id}` : base;
}

/** "In game" / "left 5 min ago": how long ago, in the words of the interface language. */
function useAgo() {
  const t = useT();
  return (since: number) => {
    const secs = Math.max(0, Math.floor(Date.now() / 1000) - since);
    if (secs < 60) return t("server.agoNow");
    if (secs < 3600) return t("server.agoMin", { n: Math.floor(secs / 60) });
    if (secs < 86400) return t("server.agoHour", { n: Math.floor(secs / 3600) });
    return t("server.agoDay", { n: Math.floor(secs / 86400) });
  };
}

function pingClass(ms: number): string {
  return ms < 70 ? "server-chip--good" : ms < 140 ? "server-chip--ok" : "server-chip--bad";
}

/** The server of the game being played (or the last one), and the games played recently. */
export function ServerSection() {
  const t = useT();
  const ago = useAgo();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { armed, arm, disarm } = useArmed();

  const load = useCallback(() => {
    invoke<ServerStatus>("get_server_status").then(setStatus).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    // the backend says when a game was joined or left
    const un = listen("server-changed", load);
    return () => {
      un.then((f) => f());
    };
  }, [load]);

  async function refresh() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setStatus(await invoke<ServerStatus>("refresh_server_status"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Deletes history older than `secs` seconds (everything for null); asks once more first. */
  async function clearHistory(id: string, secs: number | null) {
    if (armed !== id) return arm(id);
    disarm();
    setError(null);
    try {
      const before = status?.history.length ?? 0;
      const next = await invoke<ServerStatus>("clear_server_history", { olderThanSecs: secs });
      setStatus(next);
      const removed = before - next.history.length;
      setMessage(removed > 0 ? t("server.cleared", { n: removed }) : t("server.clearedNone"));
    } catch (e) {
      setError(String(e));
    }
  }

  async function copy(s: ServerInfo) {
    setError(null);
    try {
      await navigator.clipboard.writeText(joinLink(s));
      setMessage(t("server.copied"));
    } catch {
      setError(t("server.copyFailed"));
    }
  }

  const clearOptions: { id: string; secs: number | null; label: string }[] = [
    { id: "1h", secs: 3600, label: t("server.clear1h") },
    { id: "1d", secs: 86400, label: t("server.clear1d") },
    { id: "1w", secs: 604800, label: t("server.clear1w") },
    { id: "1m", secs: 2592000, label: t("server.clear1m") },
    { id: "all", secs: null, label: t("server.clearAll") },
  ];

  const cur = status?.current ?? null;
  // everything except the one shown in the big card
  const others = (status?.history ?? []).filter((h) => !cur || h.job_id !== cur.job_id || h.joined_at !== cur.joined_at);

  return (
    <section className="appearance-block">
      <h3>{t("server.heading")}</h3>
      <p className="appearance-hint">{t("server.hint")}</p>

      {!cur ? (
        <p className="server-empty">{t("server.none")}</p>
      ) : (
        <div className={`server-card ${cur.in_game ? "server-card--live" : ""}`}>
          <div className="server-card-head">
            <span className="server-dot" aria-hidden />
            <span>{cur.in_game ? t("server.inGame") : t("server.last", { when: ago(cur.joined_at) })}</span>
          </div>
          <strong className="server-game">{cur.game}</strong>
          <span className="server-place">{cur.place ?? t("server.noLocation")}</span>
          <div className="server-chips">
            {cur.ping_ms !== null && <span className={`server-chip ${pingClass(cur.ping_ms)}`}>{t("server.ping", { ms: cur.ping_ms })}</span>}
            {cur.players !== null && cur.max_players !== null && (
              <span className="server-chip">{t("server.players", { n: cur.players, max: cur.max_players })}</span>
            )}
            {cur.playing !== null && <span className="server-chip">{t("server.playing", { n: cur.playing.toLocaleString() })}</span>}
            {cur.ping_ms === null && cur.in_game && <span className="server-chip server-chip--dim">{t("server.noPing")}</span>}
          </div>
          {cur.ip && <span className="server-meta">{cur.ip}</span>}
          <div className="appearance-row">
            <button className="apply-btn" style={{ flex: 1 }} disabled={busy || !cur.in_game} onClick={refresh}>
              {busy ? t("common.working") : t("server.refresh")}
            </button>
            <button className="apply-btn" style={{ flex: 1 }} disabled={cur.place_id === null} onClick={() => copy(cur)}>
              {t("server.copyLink")}
            </button>
          </div>
        </div>
      )}

      {(status?.history.length ?? 0) > 0 && (
        <div className="server-recent">
          <h4 className="sky-mine-title">{t("server.recent", { n: status?.history.length ?? 0 })}</h4>
          {others.length > 0 && (
            <div className="server-recent-list">
              {others.map((s) => (
                <div className="server-recent-row" key={`${s.job_id ?? s.game}-${s.joined_at}`}>
                  <div className="server-recent-text">
                    <span className="server-recent-game">{s.game}</span>
                    <span className="server-recent-meta">{[s.place, ago(s.joined_at)].filter(Boolean).join(" · ")}</span>
                  </div>
                  <button
                    className="icon-btn"
                    disabled={s.place_id === null}
                    title={t("server.copyLink")}
                    aria-label={t("server.copyLinkFor", { name: s.game })}
                    onClick={() => copy(s)}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
                      <path d="M10.5 3.8V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="appearance-hint server-clear-label">{t("server.clear")}</p>
          <div className="server-clear">
            {clearOptions.map((o) => (
              <button
                key={o.id}
                className={`server-clear-btn ${armed === o.id ? "server-clear-btn--armed" : ""}`}
                data-armed={armed === o.id}
                onClick={() => clearHistory(o.id, o.secs)}
              >
                <span key={armed === o.id ? "c" : "n"} className="swap-label">
                  {armed === o.id ? t("server.clearConfirm") : o.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <StatusLine text={error ?? message} error={Boolean(error)} />
    </section>
  );
}
