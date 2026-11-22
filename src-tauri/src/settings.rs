//! Luna's own settings file (`%LOCALAPPDATA%\Luna\state\settings.json`).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::paths::luna_state_dir;

// ---------------------------------------------------------------------
// Luna's own settings (release channel, Discord RPC toggle) — separate
// from the per-version manifest/backups above.
// ---------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct LunaSettings {
    /// Passed as `--channel <name>` to RobloxPlayerBeta.exe when set,
    /// selecting a non-production release channel (e.g. "zintegration").
    pub release_channel: Option<String>,
    /// Whether the background thread in `main()` should keep Discord's
    /// Rich Presence activity updated while Roblox is running.
    pub discord_rpc_enabled: bool,
    /// File name of the font currently applied via the Appearance ->
    /// Font picker, so re-opening Settings can show what's active instead
    /// of resetting to "no file chosen".
    pub active_font_name: Option<String>,
    /// face suffix ("ft"/"bk"/"lf"/"rt"/"up"/"dn") -> source file name,
    /// for the same reason as active_font_name.
    #[serde(default)]
    pub active_sky_faces: std::collections::HashMap<String, String>,
    /// "dark" or "light" — defaults to dark via `default_theme` since an
    /// empty/older settings file has no opinion yet.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Delete Roblox's asset cache right before launching, so replaced
    /// assets are re-fetched instead of served from the old cache.
    #[serde(default)]
    pub clear_cache_on_launch: bool,
    /// Delete the cache again after Roblox exits.
    #[serde(default)]
    pub clear_cache_on_exit: bool,
    /// Put the skybox fix files back into Roblox's cache before each launch.
    #[serde(default)]
    pub skybox_fix_on_launch: bool,
    /// ReCache: keep a copy of Roblox's cache when it exits, and bring it back
    /// before a launch if the live cache was cleared.
    #[serde(default)]
    pub recache_auto: bool,
}

pub(crate) fn default_theme() -> String {
    "dark".to_string()
}

impl Default for LunaSettings {
    fn default() -> Self {
        LunaSettings {
            release_channel: None,
            discord_rpc_enabled: false,
            active_font_name: None,
            active_sky_faces: std::collections::HashMap::new(),
            theme: default_theme(),
            clear_cache_on_launch: false,
            clear_cache_on_exit: false,
            skybox_fix_on_launch: false,
            recache_auto: false,
        }
    }
}

pub(crate) fn settings_path() -> Result<PathBuf, String> {
    Ok(luna_state_dir()?.join("settings.json"))
}

#[tauri::command]
pub fn get_settings() -> Result<LunaSettings, String> {
    let path = settings_path()?;
    if !path.is_file() {
        return Ok(LunaSettings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_settings(settings: LunaSettings) -> Result<(), String> {
    let path = settings_path()?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

/// Read-modify-write on the backend so this toggle can't be overwritten by a
/// stale copy of the settings held by another part of the UI.
#[tauri::command]
pub fn set_skybox_fix_on_launch(enabled: bool) -> Result<(), String> {
    let mut settings = get_settings().unwrap_or_default();
    settings.skybox_fix_on_launch = enabled;
    update_settings(settings)
}
