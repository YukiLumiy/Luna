import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, errText, CANCELLED, type BootProgress } from "./api";
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
import { autoUpdateEnabled, checkForUpdate, isFirstStartAfterUpdate } from "./updater";
import { patchNotesFor, type PatchEntry } from "./patchNotes";
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
  // Roblox is being installed or updated by Luna: how far it is.
  const [boot, setBoot] = useState<BootProgress | null>(null);
  const alive = useRef(true);
  // Release notes, shown once on the first start after an update.
  const [notes, setNotes] = useState<PatchEntry | null>(null);
  const [appVersion, setAppVersion] = useState("");

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
    const unStart = listen("roblox-started", () => {
      setState("running");
      setBoot(null);
    });
    // A play link started a launch: this window shows its progress like the button's.
    const unBegin = listen("launch-started", () => {
      setState("launching");
      setErrorMessage(null);
    });
    const unFail = listen<string>("launch-failed", (e) => {
      setBoot(null);
      if (e.payload === CANCELLED) {
        setState("idle");
        return;
      }
      setState("error");
      setErrorMessage(e.payload);
    });
    const unBoot = listen<BootProgress>("bootstrap-progress", (e) => setBoot(e.payload));
    return () => {
      alive.current = false;
      [unExit, unStart, unBegin, unFail, unBoot].forEach((un) => un.then((f) => f()));
    };
  }, [refreshProtocol]);

  const startupChecked = useRef(false);
  useEffect(() => {
    if (startupChecked.current) return; // StrictMode runs effects twice in development
    startupChecked.current = true;
    getVersion()
      .then(async (v) => {
        setAppVersion(v);
        // the notes are part of the app (patchNotes.json); shown once, on the first start after an update
        if (await isFirstStartAfterUpdate(v)) setNotes(patchNotesFor(v));
      })
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
      const text = errText(err);
      if (text === CANCELLED) {
        setState("idle");
      } else {
        setState("error");
        setErrorMessage(text);
      }
    } finally {
      setBoot(null);
    }
  }

  const busy = state === "launching";
  // While Roblox downloads, the status line says how far it is.
  const booting = busy && boot !== null;
  const statusText =
    booting && boot.stage === "checking" ? t("boot.checking")
    : booting && boot.stage === "downloading" ? t("boot.downloading", { p: Math.floor(boot.percent) })
    : booting && boot.stage === "finalizing" ? t("boot.finalizing")
    : state === "launching" ? t("home.launching")
    : state === "running" ? t("home.running")
    : state === "error" ? errorMessage ?? t("home.failed")
    : t("home.ready");

  return (
    <div className="app">
      <TitleBar />
      {/* home screen only — Settings has its own Updates card */}
      {view === "home" && <UpdateToast />}
      <TooltipLayer />
      {notes && <PatchNotes title={t("update.whatsNew", { v: notes.version })} entries={[notes]} onClose={() => setNotes(null)} />}

      <div className="screen-viewport" data-view={view}>
        <div key={view} className={`screen screen--${direction}`}>
          {view === "settings" ? (
            <SettingsScreen onBack={() => go("home")} onProfilesChanged={refreshProtocol} />
          ) : (
            <>
              <HeroBackground sky={<MoonEmblem busy={busy} />}>
                <h1 className="welcome-title">{t("home.title")}</h1>
                <p key={booting ? `boot-${boot.stage}` : statusText} className={`welcome-status ${state === "error" ? "welcome-status--error" : ""} ${busy ? "welcome-status--busy" : ""}`}>
                  {statusText}
                </p>
                {booting && boot.stage !== "checking" && (
                  <div className="boot" aria-hidden>
                    <div className="boot-bar"><i style={{ width: `${boot.percent}%` }} /></div>
                  </div>
                )}
                <div className="actions">
                  <PrimaryButton onClick={handleLaunch} disabled={busy || state === "running"} loading={busy}>
                    {t("home.launch")}
                  </PrimaryButton>
                  {booting ? (
                    <SecondaryButton onClick={() => void api.cancelBootstrap()}>{t("boot.cancel")}</SecondaryButton>
                  ) : (
                    <SecondaryButton onClick={() => go("settings")}>{t("home.settings")}</SecondaryButton>
                  )}
                </div>
              </HeroBackground>

              <div className="footer">
                <StatusPill tone={linked ? "live" : "neutral"}>{linked === null ? "…" : linked ? t("home.linked") : t("home.notLinked")}</StatusPill>
                {appVersion && <span className="version-tag">v{appVersion}</span>}
              </div>
            </>
          )}
        </div>
      </div>

    </div>
  );
}

