//! Skybox face encoding, the built-in templates, and the on-disk truth about
//! what the Appearance section has applied.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::sky_presets::{Preset, FACE_KEYS, PRESETS};

/// Where Roblox keeps its skybox faces, relative to a version folder. Which one
/// the running client reads depends on the Roblox build: current builds ship
/// the stock faces in `PlatformContent/pc/textures/sky`, older ones in
/// `content/textures/sky` or `content/sky`. A mod profile may use any of them.
pub(crate) const SKY_DIRS: [&str; 3] = [
    "PlatformContent/pc/textures/sky",
    "content/textures/sky",
    "content/sky",
];

pub(crate) fn find_preset(slug: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.slug == slug)
}

/// Writes all six faces of a template into `sky_dir` as BC1 .tex files.
pub(crate) fn write_preset_faces(sky_dir: &Path, preset: &Preset) -> Result<usize, String> {
    fs::create_dir_all(sky_dir).map_err(|e| e.to_string())?;
    // Decode everything first so a bad face can't leave a half-written sky.
    let mut encoded = Vec::with_capacity(6);
    for (key, bytes) in FACE_KEYS.iter().zip(preset.faces.iter()) {
        let img = image::load_from_memory(bytes)
            .map_err(|e| format!("Template '{}' face {key} is damaged: {e}", preset.name))?;
        encoded.push((*key, encode_sky_image(&img)));
    }
    for (key, tex) in &encoded {
        fs::write(sky_dir.join(format!("sky512_{key}.tex")), tex).map_err(|e| e.to_string())?;
    }
    Ok(encoded.len())
}

/// Which of the six faces a path inside a profile (or version folder) is,
/// and which of the known sky directories it lives in. Case-insensitive,
/// because Windows is.
pub(crate) fn sky_face_of(relative: &str) -> Option<(&'static str, &'static str)> {
    let lower = relative.replace('\\', "/").to_ascii_lowercase();
    for dir in SKY_DIRS {
        let prefix = format!("{}/", dir.to_ascii_lowercase());
        if let Some(rest) = lower.strip_prefix(&prefix) {
            for key in FACE_KEYS {
                if rest == format!("sky512_{key}.tex") {
                    return Some((dir, key));
                }
            }
        }
    }
    None
}

/// Faces provided by any *enabled* profile, in any of the known layouts —
/// including folders the person dropped into `mods/` by hand. The value is
/// the profile's name, which is what the Appearance section shows for it.
pub(crate) fn local_sky_faces(root: &Path) -> BTreeMap<String, String> {
    let mut faces = BTreeMap::new();
    let Ok(entries) = fs::read_dir(root) else { return faces };
    let mut profiles: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    profiles.sort();
    for profile in profiles {
        let name = profile
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.starts_with(crate::mods::DISABLED_PREFIX) {
            continue;
        }
        for dir in SKY_DIRS {
            let sky_dir = profile.join(dir);
            for key in FACE_KEYS {
                if sky_dir.join(format!("sky512_{key}.tex")).is_file() {
                    faces.insert(key.to_string(), name.clone());
                }
            }
        }
    }
    faces
}

/// What is really applied right now. Luna's settings remember the names
/// of the font / faces it installed, but that memory goes stale the moment
/// the profile is switched off, deleted or emptied elsewhere — so the files
/// themselves decide. A disabled profile lives in a `_disabled_` folder, so
/// only enabled folders count. Besides Luna's own `custom-skybox`, every
/// enabled profile that carries sky faces (any layout, see `SKY_DIRS`) is
/// reported, labelled with the profile's name.
pub(crate) fn applied_state(
    root: &Path,
    font_name: &Option<String>,
    sky_faces: &HashMap<String, String>,
) -> (Option<String>, BTreeMap<String, String>) {
    let font = font_name.clone().filter(|name| {
        root.join("custom-font").join("content").join("fonts").join(name).is_file()
    });
    let mut faces = local_sky_faces(root);
    let sky_dir = root.join("custom-skybox").join("content").join("sky");
    for (key, name) in sky_faces {
        if sky_dir.join(format!("sky512_{key}.tex")).is_file() {
            faces.insert(key.clone(), name.clone());
        }
    }
    (font, faces)
}

/// Some skybox packs ship PNG/JPG data under a `.tex` name. Roblox can't
/// decode that (the face comes out black or as a wrong-coloured fill), so such
/// a file is re-encoded into a proper BC1 DDS in Luna's own state folder and
/// that copy is what gets applied. A real DDS, or anything unrecognised, is
/// used exactly as it is.
fn usable_face_source(face: &str, path: &Path) -> PathBuf {
    let Ok(bytes) = fs::read(path) else { return path.to_path_buf() };
    if bytes.starts_with(b"DDS ") || image::guess_format(&bytes).is_err() {
        return path.to_path_buf();
    }
    let Ok(img) = image::load_from_memory(&bytes) else { return path.to_path_buf() };
    let Ok(state) = crate::paths::luna_state_dir() else { return path.to_path_buf() };
    let out_dir = state.join("sky-converted");
    if fs::create_dir_all(&out_dir).is_err() {
        return path.to_path_buf();
    }
    let out = out_dir.join(format!("sky512_{face}.tex"));
    match fs::write(&out, encode_sky_image(&img)) {
        Ok(()) => out,
        Err(_) => path.to_path_buf(),
    }
}

/// Makes every enabled profile's skybox land where Roblox will look, whatever
/// layout the profile uses. Roblox reads its faces from one of `SKY_DIRS`
/// depending on the build, and a hand-made profile (or an older Luna) may only
/// carry one of them — then the client keeps using a stock or half-replaced
/// sky. So: per face, the last profile wins, and that one file is applied to
/// the current build's sky folder, to every sky folder the stock install has,
/// and to every folder a profile already used. All of them show the same sky.
pub(crate) fn mirror_sky_entries(version_folder: &Path, desired: &mut Vec<(String, PathBuf)>) {
    let mut winners: BTreeMap<&'static str, PathBuf> = BTreeMap::new();
    let mut used_dirs: Vec<&'static str> = Vec::new();
    for (relative, source) in desired.iter() {
        if let Some((dir, face)) = sky_face_of(relative) {
            winners.insert(face, source.clone());
            if !used_dirs.contains(&dir) {
                used_dirs.push(dir);
            }
        }
    }
    if winners.is_empty() {
        return;
    }

    let mut dirs: Vec<&'static str> = vec![SKY_DIRS[0]];
    for dir in SKY_DIRS {
        if version_folder.join(dir).is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    for dir in used_dirs {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }

    for (face, source) in &winners {
        let source = usable_face_source(face, source);
        for dir in &dirs {
            let relative = format!("{dir}/sky512_{face}.tex");
            let mut found = false;
            for entry in desired.iter_mut() {
                if entry.0.eq_ignore_ascii_case(&relative) {
                    entry.1 = source.clone();
                    found = true;
                }
            }
            if !found {
                desired.push((relative, source.clone()));
            }
        }
    }
}

/// Roblox's stock content/sky/sky512_*.tex files are BC1(DXT1)-compressed
/// DDS textures, not plain image bytes — copying a PNG/JPG in with just a
/// renamed extension produces a texture Roblox can't decode (it shows up
/// as a solid black face in-game instead). If the picked file is already
/// a .tex, we trust it's already correctly encoded (e.g. exported by a
/// dedicated skybox tool) and copy it as-is; otherwise we decode it,
/// resize it to the 512x512 Roblox expects, and BC1-encode it into a
/// proper DDS container ourselves.
pub(crate) fn encode_sky_face(source_path: &Path) -> Result<Vec<u8>, String> {
    let is_already_tex = source_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("tex"))
        .unwrap_or(false);

    if is_already_tex {
        return fs::read(source_path).map_err(|e| e.to_string());
    }

    let img = image::open(source_path)
        .map_err(|e| format!("Couldn't read '{}' as an image: {e}", source_path.display()))?;
    Ok(encode_sky_image(&img))
}

/// Resizes to the 512x512 Roblox expects and BC1-encodes into a DDS.
pub(crate) fn encode_sky_image(img: &image::DynamicImage) -> Vec<u8> {
    let rgba = img
        .resize_exact(512, 512, image::imageops::FilterType::Triangle)
        .to_rgba8();
    let (width, height) = (rgba.width() as usize, rgba.height() as usize);

    let format = texpresso::Format::Bc1;
    let mut compressed = vec![0u8; format.compressed_size(width, height)];
    format.compress(
        rgba.as_raw(),
        width,
        height,
        texpresso::Params::default(),
        &mut compressed,
    );

    wrap_bc1_dds(width as u32, height as u32, &compressed)
}

/// Builds a minimal DDS container (magic + 124-byte DDS_HEADER, no
/// mipmaps) around already BC1/DXT1-compressed pixel data.
pub(crate) fn wrap_bc1_dds(width: u32, height: u32, data: &[u8]) -> Vec<u8> {
    const DDSD_CAPS: u32 = 0x1;
    const DDSD_HEIGHT: u32 = 0x2;
    const DDSD_WIDTH: u32 = 0x4;
    const DDSD_PIXELFORMAT: u32 = 0x1000;
    const DDSD_LINEARSIZE: u32 = 0x80000;
    const DDPF_FOURCC: u32 = 0x4;
    const DDSCAPS_TEXTURE: u32 = 0x1000;

    let mut out = Vec::with_capacity(4 + 124 + data.len());
    out.extend_from_slice(b"DDS ");

    let mut header = [0u8; 124];
    header[0..4].copy_from_slice(&124u32.to_le_bytes()); // dwSize
    header[4..8].copy_from_slice(
        &(DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | DDSD_LINEARSIZE)
            .to_le_bytes(),
    ); // dwFlags
    header[8..12].copy_from_slice(&height.to_le_bytes());
    header[12..16].copy_from_slice(&width.to_le_bytes());
    header[16..20].copy_from_slice(&(data.len() as u32).to_le_bytes()); // dwPitchOrLinearSize
    // dwDepth, dwMipMapCount, dwReserved1[11] all stay 0

    let pf = 72; // DDS_PIXELFORMAT starts right after dwReserved1
    header[pf..pf + 4].copy_from_slice(&32u32.to_le_bytes()); // dwSize
    header[pf + 4..pf + 8].copy_from_slice(&DDPF_FOURCC.to_le_bytes()); // dwFlags
    header[pf + 8..pf + 12].copy_from_slice(b"DXT1"); // dwFourCC
    // dwRGBBitCount + 4 bitmasks stay 0

    let caps = pf + 32; // 104
    header[caps..caps + 4].copy_from_slice(&DDSCAPS_TEXTURE.to_le_bytes());
    // dwCaps2/3/4, dwReserved2 all stay 0

    out.extend_from_slice(&header);
    out.extend_from_slice(data);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("luna-sky-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn every_template_decodes_and_encodes_to_dds() {
        assert!(PRESETS.len() >= 10);
        let dir = temp("presets");
        for preset in PRESETS {
            let sky = dir.join(preset.slug);
            assert_eq!(write_preset_faces(&sky, preset).unwrap(), 6, "{}", preset.name);
            for key in FACE_KEYS {
                let bytes = fs::read(sky.join(format!("sky512_{key}.tex"))).unwrap();
                assert_eq!(&bytes[..4], b"DDS ");
                assert_eq!(bytes.len(), 4 + 124 + 512 * 512 / 2, "512x512 BC1 plus header");
            }
        }
        assert!(find_preset(PRESETS[0].slug).is_some() && find_preset("nope").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sky_faces_are_recognised_in_every_layout() {
        assert_eq!(sky_face_of("PlatformContent/pc/textures/sky/sky512_up.tex"), Some((SKY_DIRS[0], "up")));
        assert_eq!(sky_face_of("platformcontent\\pc\\textures\\sky\\SKY512_BK.TEX"), Some((SKY_DIRS[0], "bk")));
        assert_eq!(sky_face_of("content/textures/sky/sky512_ft.tex"), Some((SKY_DIRS[1], "ft")));
        assert_eq!(sky_face_of("content/sky/sky512_dn.tex"), Some((SKY_DIRS[2], "dn")));
        assert_eq!(sky_face_of("content/sky/readme.txt"), None);
        assert_eq!(sky_face_of("content/fonts/sky512_up.tex"), None);
    }

    #[test]
    fn hand_made_profiles_show_as_applied_and_follow_enabling() {
        let root = temp("local");
        let nofaces: HashMap<String, String> = HashMap::new();
        let dir = root.join("My Sky").join("PlatformContent/pc/textures/sky");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("sky512_lf.tex"), b"x").unwrap();
        fs::write(dir.join("sky512_rt.tex"), b"x").unwrap();
        let (_, faces) = applied_state(&root, &None, &nofaces);
        assert_eq!(faces.keys().map(String::as_str).collect::<Vec<_>>(), vec!["lf", "rt"]);
        assert_eq!(faces["lf"], "My Sky");

        fs::rename(root.join("My Sky"), root.join("_disabled_My Sky")).unwrap();
        assert!(applied_state(&root, &None, &nofaces).1.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_skybox_is_mirrored_into_every_sky_folder_and_the_last_profile_wins() {
        let root = temp("mirror");
        let version = root.join("version");
        fs::create_dir_all(version.join("content/sky")).unwrap();
        let a = root.join("a.tex");
        let b = root.join("b.tex");
        fs::write(&a, b"DDS a").unwrap();
        fs::write(&b, b"DDS b").unwrap();

        let mut desired = vec![
            ("content/sky/sky512_up.tex".to_string(), a.clone()),
            ("PlatformContent/pc/textures/sky/sky512_up.tex".to_string(), b.clone()),
            ("content/fonts/x.ttf".to_string(), a.clone()),
        ];
        mirror_sky_entries(&version, &mut desired);

        let source_of = |rel: &str| desired.iter().find(|(r, _)| r == rel).map(|(_, p)| p.clone());
        assert_eq!(source_of("PlatformContent/pc/textures/sky/sky512_up.tex"), Some(b.clone()));
        assert_eq!(source_of("content/sky/sky512_up.tex"), Some(b.clone()), "same sky everywhere");
        assert!(source_of("content/fonts/x.ttf").is_some(), "other files untouched");
        assert!(source_of("content/textures/sky/sky512_up.tex").is_none(), "that folder isn't in this install");
        assert_eq!(desired.len(), 3);

        // nothing sky-related -> nothing added
        let mut none = vec![("content/fonts/x.ttf".to_string(), a)];
        mirror_sky_entries(&version, &mut none);
        assert_eq!(none.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn applied_state_follows_the_files_on_disk() {
        let root = temp("state");
        let font = Some("My.ttf".to_string());
        let faces: HashMap<String, String> =
            [("up", "a.png"), ("dn", "b.png")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();

        // nothing installed -> nothing applied, whatever settings remember
        assert_eq!(applied_state(&root, &font, &faces), (None, BTreeMap::new()));

        fs::create_dir_all(root.join("custom-font/content/fonts")).unwrap();
        fs::write(root.join("custom-font/content/fonts/My.ttf"), b"x").unwrap();
        fs::create_dir_all(root.join("custom-skybox/content/sky")).unwrap();
        fs::write(root.join("custom-skybox/content/sky/sky512_up.tex"), b"x").unwrap();
        let (f, s) = applied_state(&root, &font, &faces);
        assert_eq!(f.as_deref(), Some("My.ttf"));
        assert_eq!(s.keys().collect::<Vec<_>>(), vec!["up"], "only faces that exist");

        // switching the profiles off renames the folders -> no longer applied
        fs::rename(root.join("custom-font"), root.join("_disabled_custom-font")).unwrap();
        fs::rename(root.join("custom-skybox"), root.join("_disabled_custom-skybox")).unwrap();
        assert_eq!(applied_state(&root, &font, &faces), (None, BTreeMap::new()));
        let _ = fs::remove_dir_all(&root);
    }
}
