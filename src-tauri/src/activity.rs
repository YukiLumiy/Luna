//! While Roblox runs: follows its log, and when a game is joined looks the server up (game
//! name, where it is, how many players, ping), keeps it for Settings and shows a small card at
//! the bottom right of the screen.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::logparse::{read_new, take_lines, GameSession, LogEvent, LogParser};
use crate::paths::{luna_state_dir, roblox_logs_dir};
use crate::settings::get_settings;

/// The card closes itself when its fade-out has finished; this is only the safety net for a
/// card whose page never got to run.
const POPUP_LIMIT_SECONDS: u64 = 25;
const POPUP_WIDTH: f64 = 380.0;
const POPUP_HEIGHT: f64 = 140.0;
/// A ceiling so the file cannot grow for ever (the list scrolls, and Settings can clear it).
const HISTORY_LEN: usize = 500;

static POPUP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Everything Luna knows about a game server it joined.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct ServerInfo {
    pub game: String,
    pub place_id: Option<u64>,
    pub job_id: Option<String>,
    pub ip: Option<String>,
    /// "Tokyo, Japan"
    pub place: Option<String>,
    /// Round trip from this PC to the server, when the server answers pings.
    pub ping_ms: Option<u32>,
    /// Players on this server / its capacity (only when the server shows up in Roblox's list).
    pub players: Option<u32>,
    pub max_players: Option<u32>,
    /// Players in the whole game.
    pub playing: Option<u64>,
    /// Seconds since 1970.
    pub joined_at: u64,
    /// False once the player left it.
    pub in_game: bool,
}

#[derive(Default)]
struct ServerState {
    current: Option<ServerInfo>,
    history: Vec<ServerInfo>,
    loaded: bool,
}

static STATE: Mutex<ServerState> = Mutex::new(ServerState { current: None, history: Vec::new(), loaded: false });

fn history_path() -> Option<PathBuf> {
    luna_state_dir().ok().map(|d| d.join("recent-games.json"))
}

fn lock() -> std::sync::MutexGuard<'static, ServerState> {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if !state.loaded {
        state.loaded = true;
        if let Some(raw) = history_path().and_then(|p| std::fs::read_to_string(p).ok()) {
            if let Ok(mut list) = serde_json::from_str::<Vec<ServerInfo>>(&raw) {
                // what was saved belongs to an earlier run: nobody is in these games now
                for item in &mut list {
                    item.in_game = false;
                }
                state.current = list.first().cloned();
                state.history = list;
            }
        }
    }
    state
}

fn save_history(list: &[ServerInfo]) {
    if let (Some(path), Ok(raw)) = (history_path(), serde_json::to_string(list)) {
        let _ = std::fs::write(path, raw);
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Serialize)]
pub struct ServerStatus {
    current: Option<ServerInfo>,
    history: Vec<ServerInfo>,
}

fn snapshot() -> ServerStatus {
    let state = lock();
    ServerStatus { current: state.current.clone(), history: state.history.clone() }
}

fn record(app: &AppHandle, info: ServerInfo) {
    {
        let mut state = lock();
        state.history.retain(|h| h.job_id.is_none() || h.job_id != info.job_id);
        state.history.insert(0, info.clone());
        state.history.truncate(HISTORY_LEN);
        state.current = Some(info);
        save_history(&state.history);
    }
    let _ = app.emit("server-changed", ());
}

fn mark_left(app: &AppHandle) {
    {
        let mut state = lock();
        let Some(current) = state.current.as_mut() else { return };
        if !current.in_game {
            return;
        }
        current.in_game = false;
        if let Some(job) = current.job_id.clone() {
            if let Some(entry) = state.history.iter_mut().find(|h| h.job_id.as_deref() == Some(job.as_str())) {
                entry.in_game = false;
            }
        }
        save_history(&state.history);
    }
    let _ = app.emit("server-changed", ());
}

/// Drops the entries older than `older_than` seconds (all of them for `None`), except the game
/// being played right now. Returns how many went.
fn prune_history(list: &mut Vec<ServerInfo>, now: u64, older_than: Option<u64>) -> usize {
    let before = list.len();
    let cutoff = older_than.map(|secs| now.saturating_sub(secs));
    list.retain(|h| h.in_game || cutoff.map_or(false, |c| h.joined_at >= c));
    before - list.len()
}

/// Settings -> Server -> Delete history: removes games played longer ago than the given
/// number of seconds, or every game when none is given. The game being played stays.
#[tauri::command]
pub fn clear_server_history(app: AppHandle, older_than_secs: Option<u64>) -> ServerStatus {
    {
        let mut state = lock();
        let now = now_secs();
        prune_history(&mut state.history, now, older_than_secs);
        // the "last server" card goes with its entry
        let keep = state.current.as_ref().map_or(true, |c| {
            c.in_game || state.history.iter().any(|h| h.job_id == c.job_id && h.joined_at == c.joined_at)
        });
        if !keep {
            state.current = state.history.first().cloned();
        }
        save_history(&state.history);
    }
    let _ = app.emit("server-changed", ());
    snapshot()
}

/// Settings -> Server: what is known right now.
#[tauri::command]
pub fn get_server_status() -> ServerStatus {
    snapshot()
}

/// Settings -> Server -> Refresh: measures the ping to the current server again.
#[tauri::command]
pub async fn refresh_server_status(app: AppHandle) -> ServerStatus {
    let target = {
        let state = lock();
        state.current.as_ref().filter(|c| c.in_game).and_then(|c| c.ip.clone())
    };
    if let Some(ip) = target {
        let ping = ping_ms(&ip).await;
        {
            let mut state = lock();
            if let Some(current) = state.current.as_mut() {
                if current.ip.as_deref() == Some(ip.as_str()) {
                    current.ping_ms = ping.or(current.ping_ms);
                }
            }
        }
        let _ = app.emit("server-changed", ());
    }
    snapshot()
}

/// What the card shows. It is handed to the card's page before the page runs.
#[derive(Serialize)]
struct PopupData {
    game: String,
    place: Option<String>,
    theme: String,
    ping_ms: Option<u32>,
    players: Option<u32>,
    max_players: Option<u32>,
    playing: Option<u64>,
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
                        Some(LogEvent::Left) => {
                            joined_at = None;
                            mark_left(&app);
                        }
                        None => {}
                    }
                }
            }
        }
        if joined_at.map_or(false, |t| t.elapsed() >= Duration::from_millis(1200)) {
            joined_at = None;
            let app = app.clone();
            let session = parser.session();
            tauri::async_runtime::spawn(async move { announce(app, session).await });
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    mark_left(&app);
}

// ---------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------

fn client(timeout: u64) -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("Luna")
        .timeout(Duration::from_secs(timeout))
        .build()
        .ok()
}

struct GameDetails {
    name: String,
    playing: Option<u64>,
}

/// The name of the game a place belongs to, and how many are playing it right now.
async fn game_details(place_id: u64) -> Option<GameDetails> {
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
        playing: Option<u64>,
    }

    let client = client(8)?;
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
    games.data.into_iter().next().map(|g| GameDetails { name: g.name, playing: g.playing })
}

struct ServerEntry {
    players: u32,
    max_players: u32,
}

/// Looks for this very server in the game's public server list (a few pages at most). Private
/// servers and very busy games may not be found; that is fine, the card just shows less.
async fn find_server(place_id: u64, job_id: &str) -> Option<ServerEntry> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        next_page_cursor: Option<String>,
        data: Vec<Entry>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        id: String,
        playing: Option<u32>,
        max_players: Option<u32>,
    }

    let client = client(6)?;
    let started = Instant::now();
    let mut cursor: Option<String> = None;
    for _ in 0..4 {
        if started.elapsed() > Duration::from_secs(9) {
            return None;
        }
        let mut url = format!("https://games.roblox.com/v1/games/{place_id}/servers/Public?sortOrder=Desc&limit=100");
        if let Some(c) = &cursor {
            url.push_str("&cursor=");
            url.push_str(c);
        }
        let page: Page = client.get(url).send().await.ok()?.json().await.ok()?;
        if let Some(found) = page.data.iter().find(|e| e.id.eq_ignore_ascii_case(job_id)) {
            return Some(ServerEntry { players: found.playing?, max_players: found.max_players? });
        }
        cursor = page.next_page_cursor;
        cursor.as_ref()?;
    }
    None
}

/// Round trip to `ip` in milliseconds, measured with the system's `ping`. Many game servers
/// don't answer, then there is simply no number.
async fn ping_ms(ip: &str) -> Option<u32> {
    let ip = ip.to_string();
    tokio::task::spawn_blocking(move || ping_blocking(&ip)).await.ok().flatten()
}

#[cfg(windows)]
fn ping_blocking(ip: &str) -> Option<u32> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("ping")
        .args(["-n", "3", "-w", "1500", ip])
        .creation_flags(0x0800_0000) // no console window
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    average_ms(&text)
}

#[cfg(not(windows))]
fn ping_blocking(_ip: &str) -> Option<u32> {
    None
}

/// The average of Windows' summary line ("Minimum = 12ms, Maximum = 15ms, Average = 13ms"),
/// whatever language Windows is in: it is the last of the three numbers followed by "ms".
fn average_ms(text: &str) -> Option<u32> {
    let numbers = regex::Regex::new(r"(\d+)\s*ms").ok()?;
    text.lines().rev().find_map(|line| {
        let found: Vec<u32> = numbers.captures_iter(line).filter_map(|c| c[1].parse().ok()).collect();
        (found.len() >= 3).then(|| found[2])
    })
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
    let place_id = session.place_id;
    let job_id = session.job_id.clone();
    let ip = session.candidates.iter().find(|ip| is_public(ip)).cloned();

    // everything is looked up at the same time
    let details_task = place_id.map(|id| tauri::async_runtime::spawn(async move { game_details(id).await }));
    let server_task = match (place_id, job_id.clone()) {
        (Some(id), Some(job)) => Some(tauri::async_runtime::spawn(async move { find_server(id, &job).await })),
        _ => None,
    };
    let ping_task = ip.clone().map(|ip| tauri::async_runtime::spawn(async move { ping_ms(&ip).await }));

    let mut place = None;
    for candidate in session.candidates.iter().filter(|c| is_public(c)) {
        if let Ok(found) = crate::server_location::geolocate(candidate).await {
            place = found.place();
            if place.is_some() {
                break;
            }
        }
    }
    let details = match details_task {
        Some(t) => t.await.ok().flatten(),
        None => None,
    };
    let server = match server_task {
        Some(t) => t.await.ok().flatten(),
        None => None,
    };
    let ping = match ping_task {
        Some(t) => t.await.ok().flatten(),
        None => None,
    };

    if details.is_none() && place.is_none() {
        return;
    }
    let info = ServerInfo {
        game: details.as_ref().map(|d| d.name.clone()).unwrap_or_else(|| "Roblox".to_string()),
        place_id,
        job_id,
        ip,
        place: place.clone(),
        ping_ms: ping,
        players: server.as_ref().map(|s| s.players),
        max_players: server.as_ref().map(|s| s.max_players),
        playing: details.as_ref().and_then(|d| d.playing),
        joined_at: now_secs(),
        in_game: true,
    };
    record(&app, info.clone());

    if get_settings().map(|s| s.game_popup).unwrap_or(true) {
        let theme = get_settings().map(|s| s.theme).unwrap_or_else(|_| "dark".to_string());
        show_popup(
            &app,
            PopupData {
                game: info.game,
                place,
                theme,
                ping_ms: info.ping_ms,
                players: info.players,
                max_players: info.max_players,
                playing: info.playing,
            },
        );
    }
}

// ---------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------

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
            // 56: clear of the taskbar
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

    // The card closes its own window when its fade-out is done (a page that is slow to start
    // would otherwise be cut off in the middle of it); this is only the safety net.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(POPUP_LIMIT_SECONDS)).await;
        let _ = window.close();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_average_is_the_third_number_on_the_summary_line() {
        let en = "Reply from 1.2.3.4: bytes=32 time=13ms TTL=50\r\n\r\nApproximate round trip times in milli-seconds:\r\n    Minimum = 12ms, Maximum = 15ms, Average = 13ms\r\n";
        assert_eq!(average_ms(en), Some(13));
        let ko = "    최소 = 12ms, 최대 = 15ms, 평균 = 14ms";
        assert_eq!(average_ms(ko), Some(14));
        assert_eq!(average_ms("Request timed out.\r\nPackets: Sent = 3, Received = 0, Lost = 3 (100% loss)"), None);
    }

    #[test]
    fn history_is_cleared_by_age_and_the_current_game_stays() {
        let entry = |age: u64, in_game: bool| ServerInfo { joined_at: 1_000_000 - age, in_game, ..Default::default() };
        let make = || vec![entry(0, true), entry(1_800, false), entry(7_200, false), entry(200_000, false)];
        let now = 1_000_000;

        let mut list = make();
        assert_eq!(prune_history(&mut list, now, Some(3_600)), 2); // older than an hour
        assert_eq!(list.len(), 2);

        let mut list = make();
        assert_eq!(prune_history(&mut list, now, Some(86_400)), 1); // older than a day
        assert_eq!(list.len(), 3);

        let mut list = make();
        assert_eq!(prune_history(&mut list, now, None), 3); // everything but the live game
        assert!(list.iter().all(|h| h.in_game));
    }

    #[test]
    fn private_addresses_are_skipped() {
        assert!(is_public("128.116.44.5"));
        assert!(!is_public("10.0.0.1"));
        assert!(!is_public("192.168.1.5"));
        assert!(!is_public("172.20.0.1"));
        assert!(is_public("172.32.0.1"));
    }
}
