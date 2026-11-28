//! Gives the Roblox window that Luna started Luna's name and icon: "Luna : Roblox" while no game
//! is joined, "Luna : <game name>" inside a game, with Luna's moon as the window (and taskbar) icon.
//!
//! It only changes two properties of the window from the outside — its title and its icon — with
//! the usual Win32 calls; nothing is put into Roblox's process. Only windows that are still titled
//! "Roblox" (or already carry Luna's name) are touched, and the title is put back if Roblox
//! changes it. On other systems this does nothing.

use std::collections::HashSet;
use std::sync::Mutex;

const DEFAULT_TITLE: &str = "Luna : Roblox";
/// The game being played, as the window should name it.
static GAME: Mutex<Option<String>> = Mutex::new(None);

/// Names the window after the game (`None`: no game, back to "Luna : Roblox").
pub(crate) fn set_game(name: Option<String>) {
    *GAME.lock().unwrap_or_else(|e| e.into_inner()) = name;
}

/// What the window should be called right now.
pub(crate) fn desired_title() -> String {
    match GAME.lock().unwrap_or_else(|e| e.into_inner()).as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => format!("Luna : {name}"),
        _ => DEFAULT_TITLE.to_string(),
    }
}

/// Whether a window with this title is Roblox's own (or one Luna already renamed): only those
/// are ever renamed, so no other window of the process is touched.
pub(crate) fn is_renamable(current: &str) -> bool {
    current == "Roblox" || current.starts_with("Luna : ")
}

/// Luna's icon as the two bitmaps `CreateIcon` wants for a 32-bit icon: the AND mask (the
/// inverted alpha, one byte per pixel) and the BGRA pixels.
pub(crate) fn icon_pixels(png: &[u8], size: u32) -> Option<(Vec<u8>, Vec<u8>)> {
    let img = image::load_from_memory(png)
        .ok()?
        .resize_exact(size, size, image::imageops::FilterType::Lanczos3)
        .to_rgba8();
    let mut bgra = img.into_raw();
    let mut and_mask = Vec::with_capacity(bgra.len() / 4);
    for px in bgra.chunks_exact_mut(4) {
        and_mask.push(!px[3]);
        px.swap(0, 2);
    }
    Some((and_mask, bgra))
}

#[cfg(windows)]
mod sys {
    //! The few Win32 calls needed, declared here directly (user32 is always there).
    use std::ffi::c_void;

    pub type Hwnd = *mut c_void;

    struct Search {
        pid: u32,
        found: Vec<usize>,
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: Option<unsafe extern "system" fn(Hwnd, isize) -> i32>, lparam: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn GetWindowTextW(hwnd: Hwnd, text: *mut u16, max: i32) -> i32;
        fn SendMessageTimeoutW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize, flags: u32, timeout_ms: u32, result: *mut usize) -> isize;
        fn CreateIcon(instance: *mut c_void, width: i32, height: i32, planes: u8, bits: u8, and_bits: *const u8, xor_bits: *const u8) -> *mut c_void;
    }

    const WM_SETTEXT: u32 = 0x000C;
    const WM_SETICON: u32 = 0x0080;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;
    const ICON_SMALL: usize = 0;
    const ICON_BIG: usize = 1;

    unsafe extern "system" fn collect(hwnd: Hwnd, lparam: isize) -> i32 {
        let search = &mut *(lparam as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == search.pid && IsWindowVisible(hwnd) != 0 {
            search.found.push(hwnd as usize);
        }
        1 // go on
    }

    /// The visible top-level windows of a process.
    pub fn windows_of(pid: u32) -> Vec<usize> {
        let mut search = Search { pid, found: Vec::new() };
        unsafe {
            EnumWindows(Some(collect), &mut search as *mut Search as isize);
        }
        search.found
    }

    pub fn title(hwnd: usize) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(hwnd as Hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    /// A window that doesn't answer within a third of a second is left alone.
    pub fn set_title(hwnd: usize, title: &str) {
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let mut result = 0usize;
        unsafe {
            SendMessageTimeoutW(hwnd as Hwnd, WM_SETTEXT, 0, wide.as_ptr() as isize, SMTO_ABORTIFHUNG, 300, &mut result);
        }
    }

    pub fn make_icon(size: i32, and_mask: &[u8], bgra: &[u8]) -> usize {
        unsafe { CreateIcon(std::ptr::null_mut(), size, size, 1, 32, and_mask.as_ptr(), bgra.as_ptr()) as usize }
    }

    pub fn set_icons(hwnd: usize, big: usize, small: usize) {
        let mut result = 0usize;
        unsafe {
            if big != 0 {
                SendMessageTimeoutW(hwnd as Hwnd, WM_SETICON, ICON_BIG, big as isize, SMTO_ABORTIFHUNG, 300, &mut result);
            }
            if small != 0 {
                SendMessageTimeoutW(hwnd as Hwnd, WM_SETICON, ICON_SMALL, small as isize, SMTO_ABORTIFHUNG, 300, &mut result);
            }
        }
    }
}

/// Renames and re-icons the windows of one process, again and again (the title is checked every
/// time, the icon is set once per window).
pub(crate) struct Branding {
    big: usize,
    small: usize,
    icons_made: bool,
    done: HashSet<usize>,
}

impl Branding {
    pub(crate) fn new() -> Self {
        Branding { big: 0, small: 0, icons_made: false, done: HashSet::new() }
    }

    #[cfg(windows)]
    fn make_icons(&mut self) {
        if self.icons_made {
            return;
        }
        self.icons_made = true;
        let png = include_bytes!("../icons/128x128.png");
        if let Some((and_mask, bgra)) = icon_pixels(png, 64) {
            self.big = sys::make_icon(64, &and_mask, &bgra);
        }
        if let Some((and_mask, bgra)) = icon_pixels(png, 16) {
            self.small = sys::make_icon(16, &and_mask, &bgra);
        }
    }

    #[cfg(windows)]
    pub(crate) fn tick(&mut self, pid: u32) {
        let wanted = desired_title();
        for hwnd in sys::windows_of(pid) {
            let current = sys::title(hwnd);
            if !is_renamable(&current) {
                continue;
            }
            if current != wanted {
                sys::set_title(hwnd, &wanted);
            }
            if self.done.insert(hwnd) {
                self.make_icons();
                sys::set_icons(hwnd, self.big, self.small);
            }
        }
    }

    #[cfg(not(windows))]
    pub(crate) fn tick(&mut self, _pid: u32) {
        let _ = (&self.big, &self.small, &self.icons_made, &self.done);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_follows_the_game() {
        set_game(None);
        assert_eq!(desired_title(), "Luna : Roblox");
        set_game(Some("  [🌍] RIVALS ".to_string()));
        assert_eq!(desired_title(), "Luna : [🌍] RIVALS");
        set_game(Some("   ".to_string()));
        assert_eq!(desired_title(), "Luna : Roblox");
        set_game(None);
    }

    #[test]
    fn only_robloxs_own_windows_are_renamed() {
        assert!(is_renamable("Roblox"));
        assert!(is_renamable("Luna : Roblox"));
        assert!(is_renamable("Luna : RIVALS"));
        assert!(!is_renamable("Roblox Crash Handler"));
        assert!(!is_renamable(""));
        assert!(!is_renamable("Notepad"));
    }

    #[test]
    fn the_icon_becomes_bgra_with_an_inverted_alpha_mask() {
        let mut src = image::RgbaImage::new(2, 2);
        src.put_pixel(0, 0, image::Rgba([10, 20, 30, 255]));
        src.put_pixel(1, 0, image::Rgba([40, 50, 60, 0]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(src)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let (and_mask, bgra) = icon_pixels(&png, 2).unwrap();
        assert_eq!(and_mask.len(), 4);
        assert_eq!(&bgra[0..4], &[30, 20, 10, 255]); // blue, green, red, alpha
        assert_eq!(and_mask[0], 0); // opaque pixel
        assert_eq!(and_mask[1], 255); // transparent pixel
        // the real icon file decodes at both sizes
        let png = include_bytes!("../icons/128x128.png");
        assert!(icon_pixels(png, 64).is_some() && icon_pixels(png, 16).is_some());
    }
}
