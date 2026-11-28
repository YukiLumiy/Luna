//! Launching Roblox: the Launch button and `roblox-player:` links both end up here. Luna
//! installs / updates Roblox itself first (bootstrap.rs), applies mods, starts the player, and
//! then follows the game (activity.rs).

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::bootstrap;
use crate::mods::sync_mods;
use crate::settings::get_settings;

/// A launch is under way (between pressing Launch and Roblox's process starting).
static STARTING: AtomicBool = AtomicBool::new(false);
/// This Luna process was itself started by a `roblox-player:` link (set in main).
pub(crate) static STARTED_BY_LINK: AtomicBool = AtomicBool::new(false);

/// What a launch answers when another one is still starting.
const ALREADY_STARTING: &str = "Roblox is already starting";

/// True between pressing Launch and Roblox's process starting.
pub(crate) fn is_starting() -> bool {
    STARTING.load(Ordering::SeqCst)
}

#[derive(Serialize)]
pub struct LaunchResult {
    version_folder: String,
    files_applied: usize,
    files_restored: usize,
    cache_cleared: bool,
}

/// The `roblox-player:` link among a process's arguments, if any.
pub(crate) fn roblox_uri(args: &[String]) -> Option<String> {
    args.iter()
        .find(|a| a.to_ascii_lowercase().starts_with("roblox-player:"))
        .cloned()
}

/// The Launch button: starts Roblox with no game to join.
#[tauri::command]
pub async fn apply_mods_and_launch(app_handle: AppHandle) -> Result<LaunchResult, String> {
    launch_roblox(&app_handle, Vec::new()).await
}

/// The Cancel button shown while Roblox is being downloaded.
#[tauri::command]
pub fn cancel_bootstrap() {
    bootstrap::CANCEL.store(true, Ordering::Relaxed);
}

/// Entry point for launches that arrive from outside the UI — either a
/// `roblox-player:` link that started this very process, or one handed over
/// by a second Luna instance. Anything without such a link (for example the
/// user simply opening Luna twice) is ignored.
pub(crate) fn launch_uri_if_present(app_handle: AppHandle, args: &[String]) {
    let Some(uri) = roblox_uri(args) else { return };
    tauri::async_runtime::spawn(async move {
        match launch_roblox(&app_handle, vec![uri]).await {
            // a second click on the same link while the first is under way: nothing to report
            Err(e) if e == ALREADY_STARTING => {}
            // there is no button to show this on: tell the window
            Err(e) => {
                let _ = app_handle.emit("launch-failed", e);
            }
            Ok(_) => {}
        }
    });
}

fn set_main_visible(app: &AppHandle, visible: bool) {
    if let Some(window) = app.get_webview_window("main") {
        if visible {
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            let _ = window.hide();
        }
    }
}

/// Installs or updates Roblox (or the version that is pinned), checks its files, and returns its
/// folder. If installing fails but a Roblox is already on this PC, that one is used: an old
/// Roblox that starts beats a new one that doesn't — except for a pinned version, which is
/// never swapped for another.
async fn prepare_roblox(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = get_settings().ok();
    let channel = settings.as_ref().and_then(|s| s.release_channel.clone());
    let pinned = settings
        .as_ref()
        .and_then(|s| s.pinned_roblox_version.clone())
        .filter(|v| !v.trim().is_empty());
    let verify = settings.as_ref().map(|s| s.verify_before_launch).unwrap_or(true);

    let emitter = app.clone();
    let emit: Arc<dyn Fn(bootstrap::Progress) + Send + Sync> = Arc::new(move |progress| {
        let _ = emitter.emit("bootstrap-progress", progress);
    });
    match bootstrap::ensure_latest(channel.clone(), pinned.clone(), emit.clone()).await {
        Ok(installed) => {
            // a version that was just downloaded has just been checked, file by file
            if verify && !installed.updated {
                emit(bootstrap::Progress { stage: "verifying", percent: 0.0 });
                bootstrap::verify_and_repair(&installed.dir, &installed.version, false, channel, emit)
                    .await
                    .map_err(|e| {
                        if e == bootstrap::CANCELLED {
                            e
                        } else {
                            format!("Roblox's files are damaged and couldn't be repaired: {e}")
                        }
                    })?;
            }
            Ok(installed.dir)
        }
        Err(e) if e == bootstrap::CANCELLED => Err(e),
        Err(e) if pinned.is_some() => Err(e),
        Err(e) => match bootstrap::installed_version_dir() {
            Some(dir) => Ok(dir),
            None => crate::paths::legacy_version_folder().map_err(|_| e),
        },
    }
}

pub(crate) async fn launch_roblox(
    app_handle: &AppHandle,
    passthrough_args: Vec<String>,
) -> Result<LaunchResult, String> {
    if STARTING.swap(true, Ordering::SeqCst) {
        return Err(ALREADY_STARTING.to_string());
    }
    // The window may not have started this launch itself (a link did): it shows progress too.
    let _ = app_handle.emit("launch-started", ());
    let result = launch_inner(app_handle, passthrough_args).await;
    STARTING.store(false, Ordering::SeqCst);
    result
}

async fn launch_inner(
    app_handle: &AppHandle,
    mut passthrough_args: Vec<String>,
) -> Result<LaunchResult, String> {
    let from_link = !passthrough_args.is_empty();
    let version_folder = prepare_roblox(app_handle).await?;
    let (files_applied, files_restored) = sync_mods(app_handle, &version_folder)?;

    // Optional: wipe Roblox's asset cache so nothing stale is served. A
    // failure here (files locked, Roblox already running) must never block
    // the launch itself, so it's reported rather than propagated.
    let cache_cleared = get_settings()
        .map(|s| s.clear_cache_on_launch)
        .unwrap_or(false)
        && crate::cache::clear_if_idle().is_ok();

    // ReCache: if the cache is gone (cleared above, or reset by an update), bring the
    // saved copy back so assets aren't downloaded again. Never blocks the launch.
    if get_settings().map(|s| s.recache_auto).unwrap_or(false) {
        let _ = crate::recache::restore_if_empty();
    }

    // The skybox fix goes in whenever a skybox is active (the cache clear above would have
    // deleted it, so this is every launch) and comes out when none is. Failures are ignored:
    // they must never block the launch.
    if let Ok(root) = crate::mods::mods_root(app_handle) {
        crate::skyfix::sync_with_skybox(&root);
    }

    let exe = version_folder.join("RobloxPlayerBeta.exe");

    // `passthrough_args` is the roblox-player: link (when launched from the
    // website) and goes straight through to the real client.
    if let Ok(settings) = get_settings() {
        if let Some(channel) = settings.release_channel.filter(|c| !c.trim().is_empty()) {
            passthrough_args.push("--channel".to_string());
            passthrough_args.push(channel);
        }
    }

    let started = SystemTime::now();
    let mut command = Command::new(&exe);
    command
        .args(&passthrough_args)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to launch Roblox: {e}"))?;

    // Tell the UI when this Roblox process starts and when it exits, so the
    // Launch button reflects launches that came from a website link too.
    let _ = app_handle.emit("roblox-started", ());
    let hide = get_settings().map(|s| s.hide_window_on_launch).unwrap_or(true);
    if hide {
        set_main_visible(app_handle, false);
    }
    let stop_watching = crate::activity::start(app_handle.clone(), started, child.id());

    let exit_handle = app_handle.clone();
    let quit_afterwards = from_link && STARTED_BY_LINK.load(Ordering::Relaxed);
    std::thread::spawn(move || {
        let _ = child.wait();
        stop_watching.store(true, Ordering::Relaxed);
        let _ = exit_handle.emit("roblox-exited", ());
        if quit_afterwards {
            // Luna was only opened to start this game: close it with the game, but give the
            // exit watcher (ReCache copy, cache clearing) the time it needs first.
            std::thread::sleep(Duration::from_secs(5));
            for _ in 0..120 {
                if !crate::cache::EXIT_WORK_BUSY.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            exit_handle.exit(0);
        } else if hide {
            set_main_visible(&exit_handle, true);
        }
    });

    Ok(LaunchResult {
        version_folder: version_folder.display().to_string(),
        files_applied,
        files_restored,
        cache_cleared,
    })
}
