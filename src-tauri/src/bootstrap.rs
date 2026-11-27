//! Luna's own Roblox bootstrapper: finds the current Roblox version, downloads what is missing
//! from Roblox's CDN, checks it and unpacks it into `%LOCALAPPDATA%\Luna\Versions\<version>`.
//! Roblox's own installer is never run, so the only window the player sees is Luna's.
//!
//! The steps follow Roblox's public deployment layout (the same one Bloxstrap uses):
//!  1. `clientsettingscdn.roblox.com` names the newest version (`version-<hash>`).
//!  2. `setup.rbxcdn.com/<version>-rbxPkgManifest.txt` lists the packages (zip files) with
//!     their MD5 sums.
//!  3. Every package is downloaded as `<version>-<name>`, checked, and unpacked into the folder
//!     that belongs to it (see `package_dir`).
//!
//! The version is built in `<version>.partial` and renamed once complete, so a folder that has
//! `RobloxPlayerBeta.exe` is always a whole install.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

use crate::paths::{luna_state_dir, luna_versions_dir};

const CLIENT_SETTINGS: &str = "https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer";
const CDN: &str = "https://setup.rbxcdn.com";
const PLAYER_EXE: &str = "RobloxPlayerBeta.exe";
const WORKERS: usize = 4;
/// What an aborted install reports; the UI treats it as "stopped", not as a failure.
pub const CANCELLED: &str = "Cancelled";

/// Set by the Cancel button; checked between chunks and between packages.
pub static CANCEL: AtomicBool = AtomicBool::new(false);

/// What the window shows while Roblox is being installed.
#[derive(Clone, Serialize)]
pub struct Progress {
    /// "checking" | "downloading" | "finalizing"
    pub stage: &'static str,
    /// 0 – 100
    pub percent: f32,
}

#[allow(dead_code)] // `version` and `updated` are for callers that want to tell the user what happened
pub struct Installed {
    pub dir: PathBuf,
    pub version: String,
    /// True when this call downloaded something (a first install or an update).
    pub updated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientVersion {
    client_version_upload: String,
}

struct Package {
    name: String,
    md5: String,
    packed: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct BootState {
    version: Option<String>,
}

// ---------------------------------------------------------------------
// What is installed
// ---------------------------------------------------------------------

fn state_path() -> Result<PathBuf, String> {
    Ok(luna_state_dir()?.join("bootstrap.json"))
}

fn save_state(version: &str) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(&BootState { version: Some(version.to_string()) })
        .map_err(|e| e.to_string())?;
    fs::write(state_path()?, raw).map_err(|e| e.to_string())
}

/// The folder of the Roblox version Luna installed last (and its name), if it is still whole.
pub(crate) fn installed_version() -> Option<(PathBuf, String)> {
    let versions = luna_versions_dir().ok()?;
    let saved = state_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<BootState>(&raw).ok())
        .and_then(|s| s.version);
    if let Some(version) = saved {
        let dir = versions.join(&version);
        if dir.join(PLAYER_EXE).is_file() {
            return Some((dir, version));
        }
    }
    // The state file is missing or stale: take the newest whole version folder.
    let mut best: Option<(PathBuf, String, std::time::SystemTime)> = None;
    for entry in fs::read_dir(&versions).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let dir = entry.path();
        if !name.starts_with("version-") || !dir.join(PLAYER_EXE).is_file() {
            continue;
        }
        let modified = dir.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map_or(true, |(_, _, t)| modified > *t) {
            best = Some((dir, name, modified));
        }
    }
    best.map(|(dir, name, _)| (dir, name))
}

/// The folder of the installed version, for everything that needs Roblox's files.
pub(crate) fn installed_version_dir() -> Option<PathBuf> {
    installed_version().map(|(dir, _)| dir)
}

// ---------------------------------------------------------------------
// Channels and URLs
// ---------------------------------------------------------------------

/// `None` is the normal (production) channel.
fn normalize_channel(channel: Option<&str>) -> Option<String> {
    let c = channel?.trim().to_ascii_lowercase();
    if c.is_empty() || c == "production" || c == "live" {
        None
    } else {
        Some(c)
    }
}

fn version_url(channel: &Option<String>) -> String {
    match channel {
        Some(c) => format!("{CLIENT_SETTINGS}/channel/{c}"),
        None => CLIENT_SETTINGS.to_string(),
    }
}

fn cdn_base(channel: &Option<String>) -> String {
    match channel {
        Some(c) => format!("{CDN}/channel/{c}"),
        None => CDN.to_string(),
    }
}

async fn fetch_latest(client: &reqwest::Client, channel: &Option<String>) -> Result<String, String> {
    let response = client
        .get(version_url(channel))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let parsed: ClientVersion = response.json().await.map_err(|e| e.to_string())?;
    let version = parsed.client_version_upload;
    // The name ends up in a folder path, so only the shape Roblox uses is accepted.
    if !version.starts_with("version-") || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("Unexpected version name from Roblox: {version}"));
    }
    Ok(version)
}

// ---------------------------------------------------------------------
// Package manifest
// ---------------------------------------------------------------------

fn parse_manifest(text: &str) -> Result<Vec<Package>, String> {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    match lines.next() {
        Some("v0") => {}
        other => return Err(format!("Unexpected package manifest version: {other:?}")),
    }
    let mut packages = Vec::new();
    while let Some(name) = lines.next() {
        let (Some(md5), Some(packed), Some(_unpacked)) = (lines.next(), lines.next(), lines.next()) else {
            return Err("The package manifest ends in the middle of an entry".to_string());
        };
        let packed = packed
            .parse::<u64>()
            .map_err(|_| format!("Bad size for {name} in the package manifest"))?;
        packages.push(Package { name: name.to_string(), md5: md5.to_ascii_lowercase(), packed });
    }
    if packages.is_empty() {
        return Err("The package manifest is empty".to_string());
    }
    Ok(packages)
}

/// Where a package's files go, relative to the version folder. A package this table does not
/// know is unpacked into the version folder itself (what Roblox's own installer falls back to).
fn package_dir(name: &str) -> &'static str {
    match name {
        "RobloxApp.zip" | "WebView2.zip" => "",
        "shaders.zip" => "shaders",
        "ssl.zip" => "ssl",
        "WebView2RuntimeInstaller.zip" => "WebView2RuntimeInstaller",
        "content-avatar.zip" => "content/avatar",
        "content-configs.zip" => "content/configs",
        "content-fonts.zip" => "content/fonts",
        "content-sky.zip" => "content/sky",
        "content-sounds.zip" => "content/sounds",
        "content-textures2.zip" => "content/textures",
        "content-models.zip" => "content/models",
        "content-textures3.zip" => "PlatformContent/pc/textures",
        "content-terrain.zip" => "PlatformContent/pc/terrain",
        "content-platform-fonts.zip" => "PlatformContent/pc/fonts",
        "extracontent-luua.zip" => "ExtraContent/LuaPackages",
        "extracontent-translations.zip" => "ExtraContent/translations",
        "extracontent-models.zip" => "ExtraContent/models",
        "extracontent-textures.zip" => "ExtraContent/textures",
        "extracontent-places.zip" => "ExtraContent/places",
        _ => "",
    }
}

// ---------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------

/// `base` + `rel`, or None if `rel` would leave `base` (a `..`, or a drive letter).
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for part in rel.replace('\\', "/").split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            p if p.contains(':') => return None,
            p => out.push(p),
        }
    }
    Some(out)
}

fn md5_of(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Md5::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let target = safe_join(dest, &name).ok_or_else(|| format!("Unsafe path in a package: {name}"))?;
        if entry.is_dir() || name.ends_with('/') || name.ends_with('\\') {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&target).map_err(|e| format!("{}: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------

/// Adds up the bytes of all workers and tells the window, at most every 60 ms.
struct Reporter {
    emit: Arc<dyn Fn(Progress) + Send + Sync>,
    total: u64,
    done: AtomicU64,
    last: Mutex<Instant>,
}

impl Reporter {
    fn add(&self, n: u64) {
        self.done.fetch_add(n, Ordering::Relaxed);
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if last.elapsed() < Duration::from_millis(60) {
            return;
        }
        *last = Instant::now();
        drop(last);
        self.report();
    }

    /// A download is being redone: take back what it had counted.
    fn take_back(&self, n: u64) {
        self.done.fetch_sub(n, Ordering::Relaxed);
    }

    fn report(&self) {
        let percent = self.done.load(Ordering::Relaxed) as f32 * 100.0 / self.total.max(1) as f32;
        (self.emit)(Progress { stage: "downloading", percent: percent.min(100.0) });
    }
}

fn stopped(abort: &AtomicBool) -> bool {
    CANCEL.load(Ordering::Relaxed) || abort.load(Ordering::Relaxed)
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    abort: &AtomicBool,
    reporter: &Reporter,
    counted: &AtomicU64,
) -> Result<(), String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut file = File::create(dest).map_err(|e| e.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if stopped(abort) {
            return Err(CANCELLED.to_string());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        counted.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        reporter.add(chunk.len() as u64);
    }
    Ok(())
}

struct Job {
    client: reqwest::Client,
    base: String,
    version: String,
    packages: Vec<Package>,
    next: AtomicUsize,
    downloads: PathBuf,
    out: PathBuf,
    reporter: Reporter,
    /// Set when one worker fails, so the others stop too.
    abort: AtomicBool,
}

/// Takes packages one after another: download, check (three tries), unpack.
async fn worker(job: Arc<Job>) -> Result<(), String> {
    loop {
        if stopped(&job.abort) {
            return Err(CANCELLED.to_string());
        }
        let Some(pkg) = job.packages.get(job.next.fetch_add(1, Ordering::Relaxed)) else {
            return Ok(());
        };
        let url = format!("{}/{}-{}", job.base, job.version, pkg.name);
        let zip_path = job.downloads.join(&pkg.name);

        let mut last_error = String::new();
        let mut good = false;
        for _ in 0..3 {
            let counted = AtomicU64::new(0);
            match download(&job.client, &url, &zip_path, &job.abort, &job.reporter, &counted).await {
                Ok(()) => match md5_of(&zip_path) {
                    Ok(sum) if sum == pkg.md5 => {
                        good = true;
                        break;
                    }
                    Ok(sum) => last_error = format!("checksum mismatch ({sum})"),
                    Err(e) => last_error = e,
                },
                Err(e) if e == CANCELLED => return Err(e),
                Err(e) => last_error = e,
            }
            job.reporter.take_back(counted.load(Ordering::Relaxed));
        }
        if !good {
            return Err(format!("Couldn't download {}: {last_error}", pkg.name));
        }

        let dest = safe_join(&job.out, package_dir(&pkg.name))
            .ok_or_else(|| format!("Bad folder for {}", pkg.name))?;
        let unpack_from = zip_path.clone();
        tokio::task::spawn_blocking(move || extract_zip(&unpack_from, &dest))
            .await
            .map_err(|e| e.to_string())??;
        let _ = fs::remove_file(&zip_path);
    }
}

async fn install(
    client: &reqwest::Client,
    channel: &Option<String>,
    version: &str,
    versions: &Path,
    emit: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<(), String> {
    let base = cdn_base(channel);
    let manifest = client
        .get(format!("{base}/{version}-rbxPkgManifest.txt"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let packages = parse_manifest(&manifest)?;
    let total: u64 = packages.iter().map(|p| p.packed).sum();

    let partial = versions.join(format!("{version}.partial"));
    let downloads = versions.join(".downloads").join(version);
    let _ = fs::remove_dir_all(&partial);
    let _ = fs::remove_dir_all(&downloads);
    fs::create_dir_all(&partial).map_err(|e| e.to_string())?;
    fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;

    let workers = WORKERS.min(packages.len());
    let job = Arc::new(Job {
        client: client.clone(),
        base,
        version: version.to_string(),
        packages,
        next: AtomicUsize::new(0),
        downloads: downloads.clone(),
        out: partial.clone(),
        reporter: Reporter {
            emit: emit.clone(),
            total,
            done: AtomicU64::new(0),
            last: Mutex::new(Instant::now()),
        },
        abort: AtomicBool::new(false),
    });

    let handles: Vec<_> = (0..workers).map(|_| tokio::spawn(worker(job.clone()))).collect();
    let mut errors: Vec<String> = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                job.abort.store(true, Ordering::Relaxed);
                errors.push(e);
            }
            Err(e) => {
                job.abort.store(true, Ordering::Relaxed);
                errors.push(e.to_string());
            }
        }
    }
    if !errors.is_empty() {
        let _ = fs::remove_dir_all(&partial);
        let _ = fs::remove_dir_all(&downloads);
        // A real failure is worth more than the "Cancelled" the other workers answered with.
        let real = errors.iter().find(|e| e.as_str() != CANCELLED).cloned();
        return Err(real.unwrap_or_else(|| CANCELLED.to_string()));
    }

    emit(Progress { stage: "finalizing", percent: 100.0 });
    fs::write(
        partial.join("AppSettings.xml"),
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<Settings>\r\n\t<ContentFolder>content</ContentFolder>\r\n\t<BaseUrl>http://www.roblox.com</BaseUrl>\r\n</Settings>\r\n",
    )
    .map_err(|e| e.to_string())?;
    if !partial.join(PLAYER_EXE).is_file() {
        let _ = fs::remove_dir_all(&partial);
        return Err(format!("The download did not contain {PLAYER_EXE}"));
    }
    let finished = versions.join(version);
    if finished.exists() {
        fs::remove_dir_all(&finished).map_err(|e| e.to_string())?;
    }
    fs::rename(&partial, &finished).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&downloads);
    Ok(())
}

/// Removes the versions Luna installed earlier (never while Roblox is running, and never the
/// current one) and leftovers of interrupted installs.
fn prune(versions: &Path, keep: &str) {
    let mut sys = sysinfo::System::new();
    if crate::cache::is_roblox_running(&mut sys) {
        return;
    }
    let Ok(entries) = fs::read_dir(versions) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let stale = (name.starts_with("version-") && name != keep) || name.ends_with(".partial");
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Makes sure the newest Roblox is installed and returns where. Offline (or with Roblox's
/// version service down) the installed version is used as it is.
pub async fn ensure_latest(
    channel: Option<String>,
    emit: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<Installed, String> {
    CANCEL.store(false, Ordering::Relaxed);
    let channel = normalize_channel(channel.as_deref());
    emit(Progress { stage: "checking", percent: 0.0 });

    let client = reqwest::Client::builder()
        .user_agent("Luna")
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let latest = match fetch_latest(&client, &channel).await {
        Ok(v) => v,
        Err(e) => {
            return match installed_version() {
                Some((dir, version)) => Ok(Installed { dir, version, updated: false }),
                None => Err(format!("Couldn't reach Roblox to download it: {e}")),
            };
        }
    };

    let versions = luna_versions_dir()?;
    fs::create_dir_all(&versions).map_err(|e| e.to_string())?;
    let dir = versions.join(&latest);
    let updated = !dir.join(PLAYER_EXE).is_file();
    if updated {
        install(&client, &channel, &latest, &versions, emit).await?;
    }
    save_state(&latest)?;
    prune(&versions, &latest);
    Ok(Installed { dir, version: latest, updated })
}

/// What Settings -> Updates shows about the Roblox that Luna installed.
#[derive(Serialize)]
pub struct RobloxInstall {
    /// `version-<hash>`, None when Luna has not installed Roblox yet.
    version: Option<String>,
    folder: Option<String>,
}

#[tauri::command]
pub fn get_roblox_install() -> RobloxInstall {
    match installed_version() {
        Some((dir, version)) => RobloxInstall { version: Some(version), folder: Some(dir.display().to_string()) },
        None => RobloxInstall { version: None, folder: None },
    }
}

/// Settings -> Updates -> Reinstall Roblox: removes what Luna installed, so the next launch
/// downloads a fresh, complete copy (the fix for a Roblox that no longer starts).
#[tauri::command]
pub fn reinstall_roblox() -> Result<(), String> {
    if crate::launch::is_starting() {
        return Err("Roblox is being started right now — wait until it is running, close it, then reinstall.".to_string());
    }
    if let Some(message) = crate::cache::running_message("reinstall it") {
        return Err(message);
    }
    let versions = luna_versions_dir()?;
    if versions.is_dir() {
        for entry in fs::read_dir(&versions).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("version-") || name.ends_with(".partial") || name == ".downloads" {
                fs::remove_dir_all(entry.path())
                    .map_err(|e| format!("Couldn't remove {name}: {e}"))?;
            }
        }
    }
    let _ = fs::remove_file(state_path()?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_read_in_fours() {
        let text = "v0\r\nRobloxApp.zip\r\nABCDEF\r\n100\r\n300\r\nshaders.zip\r\n123abc\r\n20\r\n40\r\n";
        let p = parse_manifest(text).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].name, "RobloxApp.zip");
        assert_eq!(p[0].md5, "abcdef");
        assert_eq!(p[1].packed, 20);
        assert!(parse_manifest("v1\nx\n").is_err());
        assert!(parse_manifest("v0\nRobloxApp.zip\nabc\n").is_err());
    }

    #[test]
    fn paths_cannot_escape() {
        let base = Path::new("/base");
        assert_eq!(safe_join(base, "content\\sky\\a.tex"), Some(PathBuf::from("/base/content/sky/a.tex")));
        assert!(safe_join(base, "../evil").is_none());
        assert!(safe_join(base, "a/../../evil").is_none());
        assert!(safe_join(base, "C:/evil").is_none());
    }

    #[test]
    fn channels() {
        assert_eq!(normalize_channel(None), None);
        assert_eq!(normalize_channel(Some("  Production ")), None);
        assert_eq!(normalize_channel(Some("ZIntegration")), Some("zintegration".to_string()));
        assert!(version_url(&Some("zintegration".into())).ends_with("/channel/zintegration"));
        assert_eq!(package_dir("content-sky.zip"), "content/sky");
        assert_eq!(package_dir("RobloxApp.zip"), "");
    }
}
