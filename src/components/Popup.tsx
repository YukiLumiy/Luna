import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n";
import { MoonDisc } from "./MoonEmblem";

export interface PopupData {
  game: string;
  place: string | null;
  theme: string;
  ping_ms: number | null;
  players: number | null;
  max_players: number | null;
  playing: number | null;
}

declare global {
  interface Window {
    /** Set by Luna before the page runs, in the small window that shows the game card. */
    __LUNA_POPUP__?: PopupData;
  }
}

const Pin = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M8 14.5s5-4.3 5-8.2A5 5 0 0 0 3 6.3c0 3.9 5 8.2 5 8.2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <circle cx="8" cy="6.3" r="1.8" fill="currentColor" />
  </svg>
);

/** The card at the bottom right of the screen when a game is joined (its own transparent window). */
export function Popup({ data }: { data: PopupData }) {
  const ping = data.ping_ms;
  const pingClass = ping === null ? "" : ping < 70 ? "popup-chip--good" : ping < 140 ? "popup-chip--ok" : "popup-chip--bad";
  const crowd =
    data.players !== null && data.max_players !== null
      ? t("popup.players", { n: data.players, max: data.max_players })
      : data.playing !== null
        ? t("popup.playing", { n: data.playing.toLocaleString() })
        : null;
  return (
    <div
      className="game-popup"
      role="status"
      // The card closes its own window once it has faded out, however long its page took to start.
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.animationName === "popup-out") void getCurrentWindow().close().catch(() => undefined);
      }}
    >
      <div className="game-popup-moon" aria-hidden>
        <svg className="game-popup-halo" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.6" strokeDasharray="1.5 7" strokeLinecap="round" />
        </svg>
        <div className="game-popup-disc">
          <MoonDisc />
        </div>
      </div>
      <div className="game-popup-text">
        <span className="game-popup-eyebrow">Luna</span>
        <strong className="game-popup-game">{data.game}</strong>
        <span className={`game-popup-place ${data.place ? "" : "game-popup-place--none"}`}>
          <Pin />
          <span>{data.place ? t("popup.server", { place: data.place }) : t("popup.noLocation")}</span>
        </span>
        {(ping !== null || crowd) && (
          <span className="game-popup-chips">
            {ping !== null && (
              <span className={`popup-chip ${pingClass}`}>
                <i aria-hidden />
                {t("popup.ping", { ms: ping })}
              </span>
            )}
            {crowd && <span className="popup-chip">{crowd}</span>}
          </span>
        )}
      </div>
      <span className="game-popup-timer" aria-hidden />
    </div>
  );
}
