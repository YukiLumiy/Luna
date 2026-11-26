//! While Roblox runs: follows its log, and when a game is joined shows a small card at the
//! bottom right of the screen with the game's name and where its server is.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::logparse::{read_new, take_lines, GameSession, LogEvent, LogParser};
use crate::paths::roblox_logs_dir;
use crate::settings::get_settings;

/// How long the card stays (its own slide-in and slide-out are part of this).
const POPUP_SECONDS: u64 = 6;
const POPUP_WIDTH: f64 = 380.0;
const POPUP_HEIGHT: f64 = 116.0;

static POPUP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// What the card shows. It is handed to the card's page before the page runs.
#[derive(Serialize)]
struct PopupData {
    game: String,
    place: Option<String>,
    theme: String,
}

/// The newest player log Roblox has written since `since`.
fn newest_log_since(since: SystemTime) -> Option<PathBuf> {
    let dir = roblox_logs_dir().ok()?;
    let earliest = since.checked_sub(Duration::from_secs(10)).unwrap_or(since);
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("log"))
        .filter(|p| p.file_name().map_or(false, |n| n.to_string_lossy().contains("Player")))
        .filter_map(|p| {
            let modified = p.metadata().ok()?.modified().ok()?;
            (modified >= earliest).then_some((p, modified))
        })
        .max_by_key(|(_, modified)| *modified)
        .map(|(p, _)| p)
}

/// Starts following the log of the Roblox that was just started. Set the returned flag to stop.
pub(crate) fn start(app: AppHandle, started: SystemTime) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    tauri::async_runtime::spawn(async move { follow(app, started, flag).await });
    stop
}

async fn follow(app: AppHandle, started: SystemTime, stop: Arc<AtomicBool>) {
    let mut parser = LogParser::new();
    let mut log: Option<PathBuf> = None;
    let mut offset = 0u64;
    let mut pending: Vec<u8> = Vec::new();
    // A join was seen: the card waits a moment for the log's remaining lines about the server.
    let mut joined_at: Option<Instant> = None;

    while !stop.load(Ordering::Relaxed) {
        if log.is_none() {
            log = newest_log_since(started);
        }
        if let Some(path) = &log {
            if let Ok(bytes) = read_new(path, &mut offset) {
                pending.extend_from_slice(&bytes);
                for line in take_lines(&mut pending) {
                    match parser.feed(&line) {
                        Some(LogEvent::Joined(_)) => joined_at = Some(Instant::now()),
                        Some(LogEvent::Left) => joined_at = None,
                        None => {}
                    }
                }
            }
        }
        if joined_at.map_or(false, |t| t.elapsed() >= Duration::from_millis(1200)) {
            joined_at = None;
            if get_settings().map(|s| s.game_popup).unwrap_or(true) {
                let app = app.clone();
                let session = parser.session();
                tauri::async_runtime::spawn(async move { announce(app, session).await });
            }
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
}

/// The name of the game a place belongs to.
async fn game_name(place_id: u64) -> Option<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Universe {
        universe_id: Option<u64>,
    }
    #[derive(Deserialize)]
    struct Games {
        data: Vec<Game>,
    }
    #[derive(Deserialize)]
    struct Game {
        name: String,
    }

    let client = reqwest::Client::builder()
        .user_agent("Luna")
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let universe: Universe = client
        .get(format!("https://apis.roblox.com/universes/v1/places/{place_id}/universe"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let id = universe.universe_id?;
    let games: Games = client
        .get(format!("https://games.roblox.com/v1/games?universeIds={id}"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    games.data.into_iter().next().map(|g| g.name)
}

/// Addresses that cannot be looked up (private networks, loopback).
fn is_public(ip: &str) -> bool {
    let parts: Vec<u8> = ip.split('.').filter_map(|p| p.parse().ok()).collect();
    match parts.as_slice() {
        [10, ..] | [127, ..] | [0, ..] | [192, 168, ..] => false,
        [172, b, ..] if (16..=31).contains(b) => false,
        [_, _, _, _] => true,
        _ => false,
    }
}

async fn announce(app: AppHandle, session: GameSession) {
    // the name and the location are looked up at the same time
    let name_task = session
        .place_id
        .map(|id| tauri::async_runtime::spawn(async move { game_name(id).await }));
    let mut place = None;
    for ip in session.candidates.iter().filter(|ip| is_public(ip)) {
        if let Ok(found) = crate::server_location::geolocate(ip).await {
            place = found.place();
            if place.is_some() {
                break;
            }
        }
    }
    let name = match name_task {
        Some(task) => task.await.ok().flatten(),
        None => None,
    };
    if name.is_none() && place.is_none() {
        return;
    }
    let theme = get_settings().map(|s| s.theme).unwrap_or_else(|_| "dark".to_string());
    show_popup(&app, PopupData { game: name.unwrap_or_else(|| "Roblox".to_string()), place, theme });
}

/// A small, click-through window at the bottom right of the main screen.
fn show_popup(app: &AppHandle, data: PopupData) {
    // one card at a time: the older one goes
    for (label, window) in app.webview_windows() {
        if label.starts_with("popup-") {
            let _ = window.close();
        }
    }

    let (x, y) = match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let origin = monitor.position().to_logical::<f64>(scale);
            // 64: clear of the taskbar
            (origin.x + size.width - POPUP_WIDTH - 12.0, origin.y + size.height - POPUP_HEIGHT - 56.0)
        }
        _ => (80.0, 80.0),
    };

    let Ok(payload) = serde_json::to_string(&data) else { return };
    let label = format!("popup-{}", POPUP_COUNTER.fetch_add(1, Ordering::Relaxed));
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Luna")
        .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .initialization_script(&format!("window.__LUNA_POPUP__ = {payload};"))
        .build();
    let Ok(window) = built else { return };
    // the game keeps every click
    let _ = window.set_ignore_cursor_events(true);

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(POPUP_SECONDS)).await;
        let _ = window.close();
    });
}
