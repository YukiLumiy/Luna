export type FlagValue = string | number | boolean;
export type Flags = Record<string, FlagValue>;

export type Preset =
  | { id: string; label: string; hint: string; kind: "toggle"; flags: Flags }
  | { id: string; label: string; hint: string; kind: "choice"; options: { label: string; flags: Flags }[] };

/**
 * Flag names follow the ones used by Bloxstrap-style launchers. Roblox renames
 * and removes flags now and then, so a preset that stops working just needs its
 * entry here updated. An option with no flags is "Default" (everything removed). Labels starting with "@" are translation keys.
 */
export const PRESETS: Preset[] = [
  {
    id: "fps", kind: "choice", label: "@preset.fps.label",
    hint: "@preset.fps.hint",
    options: [
      { label: "@common.default", flags: {} },
      ...[60, 144, 165, 240, 360].map((n) => ({ label: String(n), flags: { DFIntTaskSchedulerTargetFps: n } })),
      { label: "@preset.unlimited", flags: { DFIntTaskSchedulerTargetFps: 9999 } },
    ],
  },
  {
    id: "api", kind: "choice", label: "@preset.api.label",
    hint: "@preset.api.hint",
    options: [
      { label: "@common.default", flags: {} },
      { label: "Direct3D 11", flags: { FFlagDebugGraphicsPreferD3D11: true } },
      { label: "Vulkan", flags: { FFlagDebugGraphicsPreferVulkan: true } },
      { label: "OpenGL", flags: { FFlagDebugGraphicsPreferOpenGL: true } },
    ],
  },
  {
    id: "lighting", kind: "choice", label: "@preset.lighting.label",
    hint: "@preset.lighting.hint",
    options: [
      { label: "@common.default", flags: {} },
      { label: "Voxel", flags: { DFFlagDebugRenderForceTechnologyVoxel: true } },
      { label: "ShadowMap", flags: { FFlagDebugForceFutureIsBrightPhase2: true } },
      { label: "Future", flags: { FFlagDebugForceFutureIsBrightPhase3: true } },
    ],
  },
  {
    id: "textures", kind: "choice", label: "@preset.textures.label",
    hint: "@preset.textures.hint",
    options: [
      { label: "@common.default", flags: {} },
      ...["@preset.quality.lowest", "@preset.quality.low", "@preset.quality.medium", "@preset.quality.high"].map((label, i) => ({
        label,
        flags: { DFFlagTextureQualityOverrideEnabled: true, DFIntTextureQualityOverride: i },
      })),
    ],
  },
  { id: "sky", kind: "toggle", label: "@preset.sky.label", hint: "@preset.sky.hint", flags: { FFlagDebugSkyGray: true } },
  { id: "postfx", kind: "toggle", label: "@preset.postfx.label", hint: "@preset.postfx.hint", flags: { FFlagDisablePostFx: true } },
  { id: "msaa", kind: "toggle", label: "@preset.msaa.label", hint: "@preset.msaa.hint", flags: { FIntDebugForceMSAASamples: 0 } },
  { id: "shadows", kind: "toggle", label: "@preset.shadows.label", hint: "@preset.shadows.hint", flags: { FIntRenderShadowIntensity: 0 } },
];
