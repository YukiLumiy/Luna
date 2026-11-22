import { invoke } from "@tauri-apps/api/core";

export interface ProtocolStatus {
  registered_to_luna: boolean;
  can_restore: boolean;
}

export const api = {
  launch: () => invoke<unknown>("apply_mods_and_launch"),
  protocolStatus: () => invoke<ProtocolStatus>("get_protocol_status"),
};

/** Turn whatever invoke() rejected with into a readable string. */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
