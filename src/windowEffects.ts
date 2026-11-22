import { getCurrentWindow, Effect, EffectState } from "@tauri-apps/api/window";

/**
 * Makes the native window itself glass: Windows blurs whatever is behind it
 * (desktop, other apps) and the page, which has a translucent background in the
 * glass themes, shows over it. A web page cannot read the pixels behind its own
 * window, so that blur is done by the OS; the edge refraction in liquidGlass.ts
 * bends what the page draws itself.
 *
 * Needs `transparent: true` on the window and the core:window:allow-set-effects
 * permission. `kind` null removes the effect again.
 */
export async function setWindowGlass(kind: "glass" | "dark-glass" | null): Promise<void> {
  try {
    const win = getCurrentWindow();
    if (!kind) {
      await win.clearEffects();
      return;
    }
    await win.setEffects({
      // The first supported effect wins: Acrylic (Windows 10 1809+ / 11), else plain Blur.
      effects: [Effect.Acrylic, Effect.Blur],
      state: EffectState.Active,
      // Tint on Windows 10; Windows 11 ignores it (the page tint covers that).
      color: kind === "dark-glass" ? [10, 14, 44, 110] : [236, 239, 255, 90],
    });
  } catch (err) {
    // Unsupported system or no permission: the page still draws the glass tint, just over an opaque window.
    console.warn("window glass effect unavailable:", err);
  }
}
