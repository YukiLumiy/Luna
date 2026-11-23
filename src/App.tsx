import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, errText } from "./api";
import { useT } from "./i18n";
import { TitleBar } from "./components/TitleBar";
import { HeroBackground } from "./components/HeroBackground";
import { MoonEmblem } from "./components/MoonEmblem";
import { PrimaryButton, SecondaryButton } from "./components/Buttons";
import { StatusPill } from "./components/StatusPill";
import { SettingsScreen } from "./components/SettingsScreen";
import { applyTheme } from "./theme";
import { TooltipLayer } from "./components/TooltipLayer";
import { UpdateToast } from "./components/UpdateToast";
import { PatchNotes } from "./components/PatchNotes";
import { autoUpdateEnabled, checkForUpdate, takePatchNotes } from "./updater";
import { getVersion } from "@tauri-apps/api/app";

type LaunchState = "idle" | "launching" | "running" | "error";
type View = "home" | "settings";

export default function App() {
  const t = useT();
  const [view, setView] = useState<View>("home");
  // Which way the screen slides: forward into Settings, backward home.
  const [direction, setDirection] = useState<"forward" | "backward">("forward");
  const [state, setState] = useState<LaunchState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [linked, setLinked] = useState<boolean | null>(null);
  const alive = useRef(true);
  // Release notes, shown once on the first start after an update.
  const [notes, setNotes] = useState<{ version: string; notes: string } | null>(null);

  const refreshProtocol = useCallback(() => {
    api.protocolStatus().then((s) => alive.current && setLinked(s.registered_to_luna)).catch(() => alive.current && setLinked(null));
  }, []);

  useEffect(() => {
    alive.current = true;
    refreshProtocol();
    // The theme comes from the saved settings.
    invoke<{ theme: string }>("get_settings")
      .then((st) => applyTheme(st.theme))
      .catch(() => undefined);
    // The backend tells us when Roblox has exited.
    const unExit = listen("roblox-exited", () => setState("idle"));
    // Also covers launches that started from a roblox-player: link, not this button.
    const unStart = listen("roblox-started", () => setState("running"));
    return () => {
      alive.current = false;
      unExit.then((f) => f());
      unStart.then((f) => f());
    };
  }, [refreshProtocol]);

  const startupChecked = useRef(false);
  useEffect(() => {
    if (startupChecked.current) return; // StrictMode runs effects twice in development
    startupChecked.current = true;
    getVersion()
      .then((v) => setNotes(takePatchNotes(v)))
      .catch(() => undefined);
    // Quietly ask whether a newer release exists; the toast (top right) appears if so.
    if (autoUpdateEnabled()) void checkForUpdate(true);
  }, []);

  function go(next: View) {
    setDirection(next === "settings" ? "forward" : "backward");
    setView(next);
    // Settings may have changed the roblox-player link handler.
    if (next === "home") refreshProtocol();
  }

  async function handleLaunch() {
    setState("launching");
    setErrorMessage(null);
    try {
      await api.launch();
      setState("running");
    } catch (err) {
      setState("error");
      setErrorMessage(errText(err));
    }
  }

  const busy = state === "launching";
  const statusText =
    state === "launching" ? t("home.launching")
    : state === "running" ? t("home.running")
    : state === "error" ? errorMessage ?? t("home.failed")
    : t("home.ready");

  return (
    <div className="app">
      <TitleBar />
      {/* home screen only — Settings has its own Updates card */}
      {view === "home" && <UpdateToast />}
      <TooltipLayer />
      {notes && <PatchNotes version={notes.version} notes={notes.notes} onClose={() => setNotes(null)} />}

      <div className="screen-viewport" data-view={view}>
        <div key={view} className={`screen screen--${direction}`}>
          {view === "settings" ? (
            <SettingsScreen onBack={() => go("home")} onProfilesChanged={refreshProtocol} />
          ) : (
            <>
              <HeroBackground sky={<MoonEmblem busy={busy} />}>
                <h1 className="welcome-title">{t("home.title")}</h1>
                <p key={statusText} className={`welcome-status ${state === "error" ? "welcome-status--error" : ""} ${busy ? "welcome-status--busy" : ""}`}>
                  {statusText}
                </p>
                <div className="actions">
                  <PrimaryButton onClick={handleLaunch} disabled={busy || state === "running"} loading={busy}>
                    {t("home.launch")}
                  </PrimaryButton>
                  <SecondaryButton onClick={() => go("settings")}>{t("home.settings")}</SecondaryButton>
                </div>
              </HeroBackground>

              <div className="footer">
                <StatusPill tone={linked ? "live" : "neutral"}>{linked === null ? "…" : linked ? t("home.linked") : t("home.notLinked")}</StatusPill>
              </div>
            </>
          )}
        </div>
      </div>

    </div>
  );
}