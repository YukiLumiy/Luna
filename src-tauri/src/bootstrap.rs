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

use std::collections::{BTreeMap, HashSet};
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
    check_version_name(&version)?;
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

/// One file a package put into the version folder, kept so the install can be checked later.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct FileRecord {
    /// Path inside the version folder, with `/` separators.
    p: String,
    /// Size in bytes.
    s: u64,
    /// MD5 of the content.
    h: String,
}

/// Written into every version folder Luna installs: what each package contributed.
const MANIFEST_FILE: &str = "luna-manifest.json";

#[derive(Serialize, Deserialize, Default)]
struct InstallManifest {
    version: String,
    packages: BTreeMap<String, Vec<FileRecord>>,
}

fn read_install_manifest(dir: &Path) -> Option<InstallManifest> {
    serde_json::from_str(&fs::read_to_string(dir.join(MANIFEST_FILE)).ok()?).ok()
}

/// Unpacks `zip_path` into `dest` (which is `prefix` below the version folder) and returns what
/// it wrote, with size and checksum.
fn extract_zip(zip_path: &Path, dest: &Path, prefix: &str) -> Result<Vec<FileRecord>, String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    let mut records = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
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
        let mut hasher = Md5::new();
        let mut size = 0u64;
        loop {
            let n = entry.read(&mut buf).map_err(|e| format!("{}: {e}", target.display()))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| format!("{}: {e}", target.display()))?;
            size += n as u64;
        }
        let rel: Vec<&str> = name.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
        let path = if prefix.is_empty() { rel.join("/") } else { format!("{prefix}/{}", rel.join("/")) };
        records.push(FileRecord { p: path, s: size, h: format!("{:x}", hasher.finalize()) });
    }
    Ok(records)
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
    /// What every unpacked package wrote.
    records: Mutex<BTreeMap<String, Vec<FileRecord>>>,
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

        let prefix = package_dir(&pkg.name).to_string();
        let dest = safe_join(&job.out, &prefix).ok_or_else(|| format!("Bad folder for {}", pkg.name))?;
        let unpack_from = zip_path.clone();
        let records = tokio::task::spawn_blocking(move || extract_zip(&unpack_from, &dest, &prefix))
            .await
            .map_err(|e| e.to_string())??;
        job.records.lock().unwrap_or_else(|e| e.into_inner()).insert(pkg.name.clone(), records);
        let _ = fs::remove_file(&zip_path);
    }
}

async fn fetch_manifest(client: &reqwest::Client, base: &str, version: &str) -> Result<Vec<Package>, String> {
    let text = client
        .get(format!("{base}/{version}-rbxPkgManifest.txt"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    playable_packages(parse_manifest(&text)?)
}

/// The packages to download: the zip files. Older versions also list installer programs
/// (`RobloxPlayerInstaller.exe`, `RobloxPlayerLauncher.exe`) in their manifest; those are plain
/// files, not zips, and the player does not need them, so they are left out.
fn playable_packages(packages: Vec<Package>) -> Result<Vec<Package>, String> {
    let zips: Vec<Package> = packages
        .into_iter()
        .filter(|p| p.name.to_ascii_lowercase().ends_with(".zip"))
        .collect();
    if zips.is_empty() {
        Err("The package manifest has no zip packages".to_string())
    } else {
        Ok(zips)
    }
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Luna")
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// Downloads and unpacks `packages` into `out`, a few at a time; returns what they wrote.
async fn run_packages(
    client: &reqwest::Client,
    base: String,
    version: &str,
    packages: Vec<Package>,
    downloads: &Path,
    out: &Path,
    emit: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<BTreeMap<String, Vec<FileRecord>>, String> {
    let total: u64 = packages.iter().map(|p| p.packed).sum();
    let _ = fs::remove_dir_all(downloads);
    fs::create_dir_all(downloads).map_err(|e| e.to_string())?;

    let workers = WORKERS.min(packages.len());
    let job = Arc::new(Job {
        client: client.clone(),
        base,
        version: version.to_string(),
        packages,
        next: AtomicUsize::new(0),
        downloads: downloads.to_path_buf(),
        out: out.to_path_buf(),
        reporter: Reporter { emit, total, done: AtomicU64::new(0), last: Mutex::new(Instant::now()) },
        abort: AtomicBool::new(false),
        records: Mutex::new(BTreeMap::new()),
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
    let _ = fs::remove_dir_all(downloads);
    if !errors.is_empty() {
        // A real failure is worth more than the "Cancelled" the other workers answered with.
        let real = errors.iter().find(|e| e.as_str() != CANCELLED).cloned();
        return Err(real.unwrap_or_else(|| CANCELLED.to_string()));
    }
    let records = std::mem::take(&mut *job.records.lock().unwrap_or_else(|e| e.into_inner()));
    Ok(records)
}

async fn install(
    client: &reqwest::Client,
    channel: &Option<String>,
    version: &str,
    versions: &Path,
    emit: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<(), String> {
    let base = cdn_base(channel);
    let packages = fetch_manifest(client, &base, version).await?;

    let partial = versions.join(format!("{version}.partial"));
    let downloads = versions.join(".downloads").join(version);
    let _ = fs::remove_dir_all(&partial);
    fs::create_dir_all(&partial).map_err(|e| e.to_string())?;

    let records = match run_packages(client, base, version, packages, &downloads, &partial, emit.clone()).await {
        Ok(r) => r,
        Err(e) => {
            let _ = fs::remove_dir_all(&partial);
            return Err(e);
        }
    };

    emit(Progress { stage: "finalizing", percent: 100.0 });
    fs::write(
        partial.join("AppSettings.xml"),
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<Settings>\r\n\t<ContentFolder>content</ContentFolder>\r\n\t<BaseUrl>http://www.roblox.com</BaseUrl>\r\n</Settings>\r\n",
    )
    .map_err(|e| e.to_string())?;
    let manifest = InstallManifest { version: version.to_string(), packages: records };
    fs::write(
        partial.join(MANIFEST_FILE),
        serde_json::to_string(&manifest).map_err(|e| e.to_string())?,
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
    Ok(())
}

// ---------------------------------------------------------------------
// Checking and repairing an install
// ---------------------------------------------------------------------

/// The result of checking an install against what its packages wrote.
#[derive(Serialize, Default, Clone)]
pub struct VerifyReport {
    /// Files compared.
    pub checked: usize,
    /// Files left out because a mod replaced them on purpose.
    pub skipped_mods: usize,
    pub bad_files: usize,
    /// The packages that have a missing or changed file.
    pub bad_packages: Vec<String>,
    /// (package, path) of every file that differs.
    pub bad_paths: Vec<(String, String)>,
    /// This install has no record of its files (it was made by an older Luna).
    pub unverifiable: bool,
}

/// Compares the files of a version folder with the record made when it was installed: every
/// file must exist with its size and, when `deep`, its checksum. `skip` holds lower-case paths
/// that mods replaced.
pub(crate) fn verify_install(dir: &Path, deep: bool, skip: &HashSet<String>) -> VerifyReport {
    let Some(manifest) = read_install_manifest(dir) else {
        return VerifyReport { unverifiable: true, ..Default::default() };
    };
    let mut report = VerifyReport::default();
    for (package, files) in &manifest.packages {
        let mut damaged = false;
        for file in files {
            if skip.contains(&file.p.to_ascii_lowercase()) {
                report.skipped_mods += 1;
                continue;
            }
            report.checked += 1;
            let path = dir.join(&file.p);
            let fine = match fs::metadata(&path) {
                Ok(meta) if meta.is_file() && meta.len() == file.s => {
                    !deep || md5_of(&path).map_or(false, |h| h == file.h)
                }
                _ => false,
            };
            if !fine {
                report.bad_files += 1;
                report.bad_paths.push((package.clone(), file.p.clone()));
                damaged = true;
            }
        }
        if damaged {
            report.bad_packages.push(package.clone());
        }
    }
    report
}

/// The files mods have put over Roblox's own (relative, lower-case, `/`-separated).
fn modded_paths(dir: &Path) -> HashSet<String> {
    crate::mods::load_manifest(dir)
        .map(|m| m.active_paths.iter().map(|p| p.replace('\\', "/").to_ascii_lowercase()).collect())
        .unwrap_or_default()
}

/// Downloads the named packages of `version` again over the install in `dir`.
async fn repair(
    channel: Option<String>,
    dir: &Path,
    version: &str,
    names: &[String],
    emit: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<(), String> {
    let channel = normalize_channel(channel.as_deref());
    let client = build_client()?;
    let base = cdn_base(&channel);
    let wanted: Vec<Package> = fetch_manifest(&client, &base, version)
        .await?
        .into_iter()
        .filter(|p| names.contains(&p.name))
        .collect();
    if wanted.is_empty() {
        return Err("Roblox no longer lists the damaged part of this version".to_string());
    }
    let downloads = luna_versions_dir()?.join(".downloads").join(format!("{version}-repair"));
    let records = run_packages(&client, base, version, wanted, &downloads, dir, emit).await?;
    let mut manifest = read_install_manifest(dir).unwrap_or_default();
    manifest.version = version.to_string();
    manifest.packages.extend(records);
    fs::write(
        dir.join(MANIFEST_FILE),
        serde_json::to_string(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct VerifyOutcome {
    pub checked: usize,
    /// Packages that were damaged and have been downloaded again.
    pub repaired: Vec<String>,
    pub unverifiable: bool,
    /// Files that still differ after a fresh download (something else keeps changing them).
    /// They are no longer checked, so one stubborn file can't cause a download at every launch.
    pub still_differs: usize,
}

/// Stops checking the given files: they are taken out of the install record.
fn forget_files(dir: &Path, files: &[(String, String)]) {
    let Some(mut manifest) = read_install_manifest(dir) else { return };
    for (package, path) in files {
        if let Some(list) = manifest.packages.get_mut(package) {
            list.retain(|f| &f.p != path);
        }
    }
    if let Ok(raw) = serde_json::to_string(&manifest) {
        let _ = fs::write(dir.join(MANIFEST_FILE), raw);
    }
}

/// Checks the install in `dir` (the version `version`) and repairs what is damaged. A mod's
/// files are never counted as damage.
pub(crate) async fn verify_and_repair(
    dir: &Path,
    version: &str,
    deep: bool,
    channel: Option<String>,
    emit: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<VerifyOutcome, String> {
    let skip = modded_paths(dir);
    let check_dir = dir.to_path_buf();
    let check_skip = skip.clone();
    let report = tokio::task::spawn_blocking(move || verify_install(&check_dir, deep, &check_skip))
        .await
        .map_err(|e| e.to_string())?;
    if report.unverifiable {
        return Ok(VerifyOutcome { checked: 0, repaired: Vec::new(), unverifiable: true, still_differs: 0 });
    }
    if report.bad_packages.is_empty() {
        return Ok(VerifyOutcome { checked: report.checked, repaired: Vec::new(), unverifiable: false, still_differs: 0 });
    }

    CANCEL.store(false, Ordering::Relaxed);
    repair(channel, dir, version, &report.bad_packages, emit).await?;

    // it must be whole now
    let check_dir = dir.to_path_buf();
    let again = tokio::task::spawn_blocking(move || verify_install(&check_dir, deep, &skip))
        .await
        .map_err(|e| e.to_string())?;
    // A file that is still different after a fresh download is not Roblox's damage (two
    // packages that write the same file, a program that rewrites it). It must not stop the
    // launch, and it must not be fetched again every time: it is simply left out from now on.
    if !again.bad_paths.is_empty() {
        forget_files(dir, &again.bad_paths);
    }
    Ok(VerifyOutcome {
        checked: again.checked,
        repaired: report.bad_packages,
        unverifiable: false,
        still_differs: again.bad_files,
    })
}

// ---------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------

fn check_version_name(version: &str) -> Result<(), String> {
    // The name ends up in a folder path and a URL, so only the shape Roblox uses is accepted.
    if version.starts_with("version-") && version.len() > 8 && version.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err(format!("Not a Roblox version name: {version}"))
    }
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct RobloxVersion {
    version: String,
    /// "10/31/2024" (the date Roblox released it)
    date: String,
    /// "0.647.0.6470544"
    file_version: String,
    /// Luna has this version on disk.
    installed: bool,
    /// This is the version Luna launches right now (the one that is installed and current).
    in_use: bool,
}

/// What Settings -> Roblox -> versions gets.
#[derive(Serialize)]
pub struct RobloxVersionList {
    /// The latest releases, newest first.
    versions: Vec<RobloxVersion>,
    /// The version in use, even when it is older than the list reaches.
    current: Option<RobloxVersion>,
    /// The version that was selected (pinned), even when it is older than the list reaches.
    selected: Option<RobloxVersion>,
}

/// The Windows player releases listed in Roblox's DeployHistory.txt, oldest first.
fn parse_deploy_history(text: &str) -> Vec<RobloxVersion> {
    let Ok(line) = regex::Regex::new(
        r"^New WindowsPlayer (version-[0-9a-fA-F]+) at (\d+/\d+/\d+) [^,]*, file version: (\d+), (\d+), (\d+), (\d+)",
    ) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for l in text.lines() {
        if let Some(c) = line.captures(l.trim()) {
            if seen.insert(c[1].to_string()) {
                out.push(RobloxVersion {
                    version: c[1].to_string(),
                    date: c[2].to_string(),
                    file_version: format!("{}.{}.{}.{}", &c[3], &c[4], &c[5], &c[6]),
                    installed: false,
                    in_use: false,
                });
            }
        }
    }
    out
}

/// Settings -> Roblox -> versions: the latest releases, newest first.
#[tauri::command]
pub async fn list_roblox_versions() -> Result<RobloxVersionList, String> {
    let settings = crate::settings::get_settings().ok();
    let channel = normalize_channel(settings.as_ref().and_then(|s| s.release_channel.clone()).as_deref());
    let pinned = settings.and_then(|s| s.pinned_roblox_version);
    let client = reqwest::Client::builder()
        .user_agent("Luna")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let text = client
        .get(format!("{}/DeployHistory.txt", cdn_base(&channel)))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let versions_dir = luna_versions_dir()?;
    let in_use = installed_version().map(|(_, v)| v);
    let mut all = parse_deploy_history(&text);
    for v in &mut all {
        v.installed = versions_dir.join(&v.version).join(PLAYER_EXE).is_file();
        v.in_use = in_use.as_deref() == Some(v.version.as_str());
    }
    let current = all.iter().find(|v| v.in_use).cloned();
    let selected = pinned.and_then(|p| all.iter().find(|v| v.version == p).cloned());
    all.reverse();
    all.truncate(40);
    if all.is_empty() {
        return Err("Roblox's release list had no versions in it".to_string());
    }
    Ok(RobloxVersionList { versions: all, current, selected })
}

/// What was typed or chosen as a version: `version-b7e22355` as it is, or just the hash.
fn normalize_version_input(raw: &str) -> String {
    let t = raw.trim().to_ascii_lowercase();
    if t.is_empty() || t.starts_with("version-") || !t.chars().all(|c| c.is_ascii_hexdigit()) {
        t
    } else {
        format!("version-{t}")
    }
}

/// A version that isn't on this PC has to exist on Roblox's servers. A server that says "not
/// there" is believed; being offline (or any other answer) is not held against the version, the
/// launch will find out.
async fn check_version_exists(channel: &Option<String>, version: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("Luna")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(format!("{}/{version}-rbxPkgManifest.txt", cdn_base(channel))).send().await {
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND || r.status() == reqwest::StatusCode::FORBIDDEN => {
            Err(format!("Roblox has no version called {version} on its servers (it may never have existed, or it was removed)."))
        }
        _ => Ok(()),
    }
}

/// Settings -> Roblox: stay on this version (None goes back to always using the newest). The
/// version may be one from the list or typed in by hand; it is downloaded at the next launch if
/// it isn't on disk yet.
#[tauri::command]
pub async fn set_roblox_pin(version: Option<String>) -> Result<(), String> {
    let version = version.map(|v| normalize_version_input(&v)).filter(|v| !v.is_empty());
    if let Some(v) = &version {
        check_version_name(v)?;
        let on_disk = luna_versions_dir().map(|d| d.join(v).join(PLAYER_EXE).is_file()).unwrap_or(false);
        if !on_disk {
            let channel = normalize_channel(crate::settings::get_settings().ok().and_then(|s| s.release_channel).as_deref());
            check_version_exists(&channel, v).await?;
        }
    }
    let mut settings = crate::settings::get_settings()?;
    settings.pinned_roblox_version = version;
    crate::settings::update_settings(settings)
}

/// Settings -> Roblox -> Check files: compares every file with the install record and downloads
/// damaged parts again. `deep` also compares checksums (slower, finds changed contents).
#[tauri::command]
pub async fn verify_roblox_files(app: tauri::AppHandle, deep: bool) -> Result<VerifyOutcome, String> {
    use tauri::Emitter;
    if crate::launch::is_starting() {
        return Err("Roblox is being started right now — try again once it is running.".to_string());
    }
    if let Some(message) = crate::cache::running_message("check its files") {
        return Err(message);
    }
    let (dir, version) = installed_version().ok_or("Luna hasn't installed Roblox yet — launch it once first.")?;
    let channel = crate::settings::get_settings().ok().and_then(|s| s.release_channel);
    let emitter = app.clone();
    let emit: Arc<dyn Fn(Progress) + Send + Sync> = Arc::new(move |p| {
        let _ = emitter.emit("bootstrap-progress", p);
    });
    verify_and_repair(&dir, &version, deep, channel, emit).await
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

/// Makes sure the wanted Roblox is installed and returns where: the version `pinned` names, or
/// the newest. Offline (or with Roblox's version service down) the installed version is used as
/// it is — unless a version is pinned and missing, which can't be answered with another one.
pub async fn ensure_latest(
    channel: Option<String>,
    pinned: Option<String>,
    emit: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<Installed, String> {
    CANCEL.store(false, Ordering::Relaxed);
    let channel = normalize_channel(channel.as_deref());
    emit(Progress { stage: "checking", percent: 0.0 });

    let client = build_client()?;

    let pinned = pinned.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let latest = match &pinned {
        Some(version) => {
            check_version_name(version)?;
            version.clone()
        }
        None => match fetch_latest(&client, &channel).await {
            Ok(v) => v,
            Err(e) => {
                return match installed_version() {
                    Some((dir, version)) => Ok(Installed { dir, version, updated: false }),
                    None => Err(format!("Couldn't reach Roblox to download it: {e}")),
                };
            }
        },
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
    fn deploy_history_is_read_and_deduplicated() {
        let text = "New WindowsPlayer version-aaaa1111 at 10/30/2024 9:01:02 AM, file version: 0, 646, 0, 6460001, git hash: abc ...\r\nNew Studio64 version-ffff at 10/30/2024 9:05:00 AM, file version: 0, 646, 0, 1, git hash: x\r\nNew WindowsPlayer version-bbbb2222 at 10/31/2024 1:22:41 PM, file version: 0, 647, 0, 6470544, git hash: abc ...\r\nNew WindowsPlayer version-bbbb2222 at 11/1/2024 1:22:41 PM, file version: 0, 647, 0, 6470544, git hash: abc ...\r\nDone\r\n";
        let v = parse_deploy_history(text);
        assert_eq!(v.len(), 2);
        assert_eq!(v[1].version, "version-bbbb2222");
        assert_eq!(v[1].date, "10/31/2024");
        assert_eq!(v[1].file_version, "0.647.0.6470544");
    }

    #[test]
    fn typed_versions_are_tidied() {
        assert_eq!(normalize_version_input("  version-B7E22355 "), "version-b7e22355");
        assert_eq!(normalize_version_input("b7e22355"), "version-b7e22355");
        assert_eq!(normalize_version_input("hello"), "hello"); // rejected later by the name check
        assert_eq!(normalize_version_input("   "), "");
    }

    #[test]
    fn installer_programs_in_old_manifests_are_not_downloaded() {
        let text = "v0\nRobloxPlayerInstaller.exe\n0123\n10\n20\nRobloxApp.zip\nabcd\n30\n60\nRobloxPlayerLauncher.exe\nffff\n5\n9\ncontent-sky.zip\n1111\n7\n14\n";
        let kept = playable_packages(parse_manifest(text).unwrap()).unwrap();
        let names: Vec<&str> = kept.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["RobloxApp.zip", "content-sky.zip"]);
        assert!(playable_packages(parse_manifest("v0\nRobloxPlayerInstaller.exe\n0123\n10\n20\n").unwrap()).is_err());
    }

    #[test]
    fn version_names_are_checked() {
        assert!(check_version_name("version-0a1b2c3d4e5f").is_ok());
        assert!(check_version_name("version-").is_err());
        assert!(check_version_name("../version-abc").is_err());
        assert!(check_version_name("abc").is_err());
    }

    #[test]
    fn an_install_is_verified_against_its_record() {
        let root = std::env::temp_dir().join("luna-verify-test");
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("version-test");
        fs::create_dir_all(dir.join("content/sky")).unwrap();

        // a package with two files
        let zip_path = root.join("p.zip");
        {
            let mut w = zip::ZipWriter::new(File::create(&zip_path).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("sky_bk.tex", opts).unwrap();
            w.write_all(b"back").unwrap();
            w.start_file("sub\\sky_ft.tex", opts).unwrap();
            w.write_all(b"front").unwrap();
            w.finish().unwrap();
        }
        let records = extract_zip(&zip_path, &dir.join("content/sky"), "content/sky").unwrap();
        assert_eq!(records.len(), 2);
        assert!(records.iter().any(|r| r.p == "content/sky/sub/sky_ft.tex" && r.s == 5));
        let mut packages = BTreeMap::new();
        packages.insert("content-sky.zip".to_string(), records);
        fs::write(
            dir.join(MANIFEST_FILE),
            serde_json::to_string(&InstallManifest { version: "version-test".into(), packages }).unwrap(),
        )
        .unwrap();

        let none = HashSet::new();
        assert!(verify_install(&dir, true, &none).bad_packages.is_empty());

        // same size, different content: only the thorough check sees it
        fs::write(dir.join("content/sky/sky_bk.tex"), b"BACK").unwrap();
        assert!(verify_install(&dir, false, &none).bad_packages.is_empty());
        let deep = verify_install(&dir, true, &none);
        assert_eq!(deep.bad_packages, vec!["content-sky.zip".to_string()]);

        // ...unless a mod replaced that file on purpose
        let modded: HashSet<String> = ["content/sky/sky_bk.tex".to_string()].into();
        let skipped = verify_install(&dir, true, &modded);
        assert!(skipped.bad_packages.is_empty());
        assert_eq!(skipped.skipped_mods, 1);

        // a missing file shows up even in the quick check
        fs::remove_file(dir.join("content/sky/sub/sky_ft.tex")).unwrap();
        assert_eq!(verify_install(&dir, false, &modded).bad_files, 1);

        // a file that stays different is dropped from the record, so it is not asked about again
        let still = verify_install(&dir, false, &modded);
        assert_eq!(still.bad_paths.len(), 1);
        forget_files(&dir, &still.bad_paths);
        assert!(verify_install(&dir, false, &modded).bad_packages.is_empty());

        // no record: it can't be judged
        fs::remove_file(dir.join(MANIFEST_FILE)).unwrap();
        assert!(verify_install(&dir, false, &none).unverifiable);
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
