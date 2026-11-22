//! ReCache: keeps a copy of Roblox's asset cache (`rbx-storage*`) in Luna's own
//! folder, so clearing the cache (or Roblox resetting it) doesn't mean downloading
//! every texture and model again. The copy is incremental: cache files are named
//! after their content, so a file that is already in the copy with the same size
//! is skipped. Restoring never brings back the six default skybox entries, so a
//! skybox replacement (see skyfix.rs) is not undone by it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sysinfo::System;

use crate::paths::{luna_state_dir, roblox_local_dir};

const CACHE_PREFIX: &str = "rbx-storage";
const STAMP: &str = "saved_at.txt";

fn snapshot_dir() -> Result<PathBuf, String> {
    let dir = luna_state_dir()?.join("recache");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let p = e.path();
            if p.is_dir() { dir_size(&p) } else { p.metadata().map(|m| m.len()).unwrap_or(0) }
        })
        .sum()
}

fn is_cache_entry(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().to_lowercase().starts_with(CACHE_PREFIX))
        .unwrap_or(false)
}

/// The database and its sidecars change in place under the same name and size,
/// so they are always copied; hashed files never change.
fn always_copy(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".db") || n.ends_with("-wal") || n.ends_with("-shm") || n.ends_with("-journal")
}

fn sync_file(src: &Path, dst: &Path, skip: &dyn Fn(&str) -> bool, copied: &mut u64) -> Result<(), String> {
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if skip(&name) {
        return Ok(());
    }
    let len = src.metadata().map(|m| m.len()).unwrap_or(0);
    let same = dst.metadata().map(|m| m.len() == len).unwrap_or(false);
    if same && !always_copy(&name) {
        return Ok(());
    }
    if let Ok(meta) = fs::metadata(dst) {
        let mut perms = meta.permissions();
        perms.set_readonly(false);
        let _ = fs::set_permissions(dst, perms);
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    *copied += fs::copy(src, dst).map_err(|e| format!("Couldn't copy {}: {e}", src.display()))?;
    Ok(())
}

fn sync_tree(src: &Path, dst: &Path, skip: &dyn Fn(&str) -> bool, copied: &mut u64) -> Result<(), String> {
    if !src.is_dir() {
        return sync_file(src, dst, skip, copied);
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let target = dst.join(path.file_name().unwrap_or_default());
        sync_tree(&path, &target, skip, copied)?;
    }
    Ok(())
}

fn cache_entries() -> Result<Vec<PathBuf>, String> {
    let dir = roblox_local_dir()?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    Ok(fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| is_cache_entry(p))
        .collect())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Copies Roblox's current cache into the copy. Doesn't check whether Roblox
/// is running — callers do.
pub(crate) fn save_snapshot_files() -> Result<u64, String> {
    let snap = snapshot_dir()?;
    let mut copied = 0;
    let none = |_: &str| false;
    for entry in cache_entries()? {
        let name = entry.file_name().unwrap_or_default().to_os_string();
        sync_tree(&entry, &snap.join(name), &none, &mut copied)?;
    }
    fs::write(snap.join(STAMP), now_secs().to_string()).map_err(|e| e.to_string())?;
    Ok(copied)
}

fn restore_files() -> Result<u64, String> {
    let snap = snapshot_dir()?;
    let local = roblox_local_dir()?;
    fs::create_dir_all(&local).map_err(|e| e.to_string())?;
    let skip_default_sky = |name: &str| crate::skyfix::is_default_sky_entry(name);
    let mut copied = 0;
    for entry in fs::read_dir(&snap).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !is_cache_entry(&path) {
            continue;
        }
        let target = local.join(path.file_name().unwrap_or_default());
        sync_tree(&path, &target, &skip_default_sky, &mut copied)?;
    }
    Ok(copied)
}

fn roblox_running() -> bool {
    crate::cache::is_roblox_running(&mut System::new())
}

/// Before a launch: if the live cache is gone or nearly empty (cleared, or reset
/// by an update) and a copy exists, bring the copy back.
pub(crate) fn restore_if_empty() -> Result<u64, String> {
    let live: u64 = cache_entries()?.iter().map(|p| if p.is_dir() { dir_size(p) } else { p.metadata().map(|m| m.len()).unwrap_or(0) }).sum();
    let snap = snapshot_dir()?;
    if live > 1024 * 1024 || !snap.join(STAMP).is_file() {
        return Ok(0);
    }
    restore_files()
}

#[derive(Serialize)]
pub struct RecacheStatus {
    pub has_snapshot: bool,
    pub snapshot_bytes: u64,
    pub saved_at: Option<u64>,
    pub cache_bytes: u64,
}

#[tauri::command]
pub async fn get_recache_status() -> Result<RecacheStatus, String> {
    let snap = snapshot_dir()?;
    let saved_at = fs::read_to_string(snap.join(STAMP)).ok().and_then(|s| s.trim().parse().ok());
    let cache_bytes = cache_entries()?
        .iter()
        .map(|p| if p.is_dir() { dir_size(p) } else { p.metadata().map(|m| m.len()).unwrap_or(0) })
        .sum();
    Ok(RecacheStatus { has_snapshot: saved_at.is_some(), snapshot_bytes: dir_size(&snap), saved_at, cache_bytes })
}

/// Settings -> ReCache -> "Save now". Returns the bytes newly copied.
#[tauri::command]
pub async fn recache_save() -> Result<u64, String> {
    if roblox_running() {
        return Err("Roblox is running — close it first.".into());
    }
    save_snapshot_files()
}

/// Settings -> ReCache -> "Restore now". Returns the bytes copied back.
#[tauri::command]
pub async fn recache_restore() -> Result<u64, String> {
    if roblox_running() {
        return Err("Roblox is running — close it first.".into());
    }
    if !snapshot_dir()?.join(STAMP).is_file() {
        return Err("There is no saved copy yet.".into());
    }
    restore_files()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_is_incremental_and_honours_skips() {
        let base = std::env::temp_dir().join(format!("luna-recache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (src, dst) = (base.join("src"), base.join("dst"));
        fs::create_dir_all(src.join("ab")).unwrap();
        fs::write(src.join("ab").join("hash1"), b"1111").unwrap();
        fs::write(src.join("skipme"), b"x").unwrap();
        fs::write(src.join("rbx-storage.db"), b"v1").unwrap();

        let mut n = 0;
        let skip = |name: &str| name == "skipme";
        sync_tree(&src, &dst, &skip, &mut n).unwrap();
        assert!(dst.join("ab/hash1").is_file() && !dst.join("skipme").exists());
        assert_eq!(n, 6);

        // second pass: the hashed file is skipped, the database is refreshed
        fs::write(src.join("rbx-storage.db"), b"v2").unwrap();
        let mut n2 = 0;
        sync_tree(&src, &dst, &skip, &mut n2).unwrap();
        assert_eq!(n2, 2);
        assert_eq!(fs::read(dst.join("rbx-storage.db")).unwrap(), b"v2");
        let _ = fs::remove_dir_all(&base);
    }
}
