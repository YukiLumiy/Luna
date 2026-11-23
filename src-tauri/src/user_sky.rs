//! Skybox presets the person saved themselves: a named set of faces kept in
//! `%LOCALAPPDATA%\Luna\state\user-sky-presets\<name>\` that can be applied
//! again at any time, like the built-in templates.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::mods::{ensure_profile_writable, mods_root, validate_profile_name};
use crate::paths::luna_state_dir;
use crate::settings::{get_settings, update_settings};
use crate::sky::{decode_bc1_dds, encode_sky_face, SKY_DIRS};
use crate::sky_presets::FACE_KEYS;

fn presets_root() -> Result<PathBuf, String> {
    let dir = luna_state_dir()?.join("user-sky-presets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() / 3 * 4 + 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

#[derive(Serialize)]
pub struct UserPresetInfo {
    name: String,
    faces: Vec<String>,
    /// `data:image/jpeg;base64,...`, when a preview could be made.
    thumb: Option<String>,
}

fn face_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("sky512_{key}.tex"))
}

/// A saved skybox is previewed by one of its own faces (front if it has one, else the
/// first it has), decoded from the stored `.tex` — so the preview always matches what is
/// applied, whatever kind of file the face came from. Written as `thumb.jpg` in the preset.
fn make_thumb(dir: &Path) {
    for key in ["ft", "lf", "rt", "bk", "up", "dn"] {
        let Ok(bytes) = fs::read(face_file(dir, key)) else { continue };
        let Some(img) = decode_bc1_dds(&bytes) else { continue };
        let thumb = image::DynamicImage::ImageRgb8(img).thumbnail(128, 128).to_rgb8();
        if thumb.save_with_format(dir.join("thumb.jpg"), image::ImageFormat::Jpeg).is_ok() {
            return;
        }
    }
}

/// The name Luna remembers for the faces of a saved skybox, so it can't be mistaken
/// for a built-in template of the same name.
fn applied_label(name: &str) -> String {
    format!("my:{name}")
}

fn checked_name(name: &str) -> Result<String, String> {
    validate_profile_name(name)
}

#[tauri::command]
pub fn list_user_sky_presets() -> Result<Vec<UserPresetInfo>, String> {
    let root = presets_root()?;
    let mut list = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let faces = FACE_KEYS
            .iter()
            .filter(|k| face_file(&path, k).is_file())
            .map(|k| k.to_string())
            .collect();
        if !path.join("thumb.jpg").is_file() {
            make_thumb(&path); // presets saved before previews existed
        }
        let thumb = fs::read(path.join("thumb.jpg"))
            .ok()
            .map(|b| format!("data:image/jpeg;base64,{}", base64(&b)));
        list.push(UserPresetInfo { name, faces, thumb });
    }
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(list)
}

/// Saves the faces picked in the Skybox section (`faces`: face key -> image path)
/// under `name`. A face that wasn't picked is taken from the skybox that is
/// applied right now, so "tweak one face, save" keeps the other five.
#[tauri::command]
pub fn save_user_sky_preset(
    app_handle: tauri::AppHandle,
    name: String,
    faces: HashMap<String, String>,
) -> Result<String, String> {
    // Built-in templates and saved skyboxes are separate lists: the same name is fine.
    let name = checked_name(&name)?;

    let root = mods_root(&app_handle)?;
    let applied_dir = root.join("custom-skybox").join("content").join("sky");

    let mut encoded: Vec<(&str, Vec<u8>)> = Vec::new();
    for key in FACE_KEYS {
        if let Some(path) = faces.get(key) {
            encoded.push((key, encode_sky_face(Path::new(path))?));
        } else if let Ok(bytes) = fs::read(face_file(&applied_dir, key)) {
            encoded.push((key, bytes));
        }
    }
    if encoded.is_empty() {
        return Err("Pick at least one face first".into());
    }

    let dir = presets_root()?.join(&name);
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (key, bytes) in &encoded {
        fs::write(face_file(&dir, key), bytes).map_err(|e| e.to_string())?;
    }
    make_thumb(&dir);
    Ok(name)
}

/// Makes a saved preset the applied skybox: the `custom-skybox` profile is
/// rewritten with exactly its faces.
#[tauri::command]
pub fn apply_user_sky_preset(app_handle: tauri::AppHandle, name: String) -> Result<String, String> {
    let name = checked_name(&name)?;
    let dir = presets_root()?.join(&name);
    if !dir.is_dir() {
        return Err(format!("No saved skybox named '{name}'"));
    }
    let root = mods_root(&app_handle)?;
    let profile = ensure_profile_writable(&root, "custom-skybox")?;
    let sky_dir = profile.join("content").join("sky");
    if sky_dir.is_dir() {
        fs::remove_dir_all(&sky_dir).map_err(|e| e.to_string())?;
    }
    // Older Luna versions or a hand-made layout may have left faces elsewhere in the profile.
    for other in SKY_DIRS.iter() {
        let d = profile.join(other);
        if d != sky_dir && d.is_dir() {
            let _ = fs::remove_dir_all(&d);
        }
    }
    fs::create_dir_all(&sky_dir).map_err(|e| e.to_string())?;

    let mut settings = get_settings().unwrap_or_default();
    settings.active_sky_faces.clear();
    let mut written = 0;
    for key in FACE_KEYS {
        let src = face_file(&dir, key);
        if src.is_file() {
            fs::copy(&src, face_file(&sky_dir, key)).map_err(|e| e.to_string())?;
            settings.active_sky_faces.insert(key.to_string(), applied_label(&name));
            written += 1;
        }
    }
    if written == 0 {
        return Err("That saved skybox has no faces".into());
    }
    let _ = update_settings(settings);
    crate::skyfix::sync_with_skybox(&root);
    Ok(name)
}

/// Renames a saved skybox. If it is the one applied right now, the remembered name follows.
#[tauri::command]
pub fn rename_user_sky_preset(old_name: String, new_name: String) -> Result<String, String> {
    let old = checked_name(&old_name)?;
    let new = checked_name(&new_name)?;
    let root = presets_root()?;
    let (from, to) = (root.join(&old), root.join(&new));
    if !from.is_dir() {
        return Err(format!("No saved skybox named '{old}'"));
    }
    if old == new {
        return Ok(new);
    }
    if to.exists() && !old.eq_ignore_ascii_case(&new) {
        return Err(format!("A saved skybox named '{new}' already exists"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    let mut settings = get_settings().unwrap_or_default();
    let (was, now) = (applied_label(&old), applied_label(&new));
    for label in settings.active_sky_faces.values_mut() {
        if *label == was {
            *label = now.clone();
        }
    }
    let _ = update_settings(settings);
    Ok(new)
}

#[tauri::command]
pub fn delete_user_sky_preset(name: String) -> Result<(), String> {
    let name = checked_name(&name)?;
    let dir = presets_root()?.join(&name);
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
