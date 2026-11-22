import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "../assets/logo.svg";
import { useT } from "../i18n";

export function TitleBar() {
  const t = useT();
  const appWindow = getCurrentWindow();

  return (
    <div data-tauri-drag-region className="titlebar">
      <div className="titlebar-left" data-tauri-drag-region>
        <img src={logo} alt="" className="titlebar-logo" draggable={false} />
        <span className="titlebar-name">Luna</span>
      </div>

      <div className="titlebar-controls">
        <button aria-label={t("common.minimize")} className="titlebar-btn" onClick={() => appWindow.minimize()}>
          <svg width="10" height="1.2" viewBox="0 0 10 1.2"><rect width="10" height="1.2" fill="currentColor" /></svg>
        </button>
        <button aria-label={t("common.close")} className="titlebar-btn titlebar-btn--close" onClick={() => appWindow.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
      </div>

    </div>
  );
}
