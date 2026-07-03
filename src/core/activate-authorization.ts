import type { PskCategory } from "./noise/psk";
import type { GoodbyeReason } from "../types";

type Activity = "playback" | "pairing" | "management";

export type AuthResult = { ok: true } | { ok: false; goodbye: GoodbyeReason };

/** Is this activity set allowed at all for the matched PSK category? */
function isAllowedActivitySet(
  category: PskCategory,
  set: Set<Activity>,
  unpairedAccess: boolean,
): boolean {
  if (category === "long_term") {
    // ['pairing'] alone, or any subset of {playback, management}.
    if (set.has("pairing")) return set.size === 1;
    for (const a of set)
      if (a !== "playback" && a !== "management") return false;
    return true;
  }
  if (category === "pairing") {
    return set.size === 1 && set.has("pairing");
  }
  // sentinel
  if (set.size === 0) return true;
  if (set.size === 1 && set.has("pairing")) return true;
  if (set.size === 1 && set.has("playback")) return unpairedAccess;
  return false;
}

export function authorizeActivate(
  category: PskCategory,
  activities: Activity[],
  activeRoles: string[] | undefined,
  unpairedAccess: boolean,
): AuthResult {
  const set = new Set(activities);

  if (!isAllowedActivitySet(category, set, unpairedAccess)) {
    // pairing_required only when enabling unpaired access would make it admissible
    // (i.e. a Sentinel ['playback'] activation blocked solely by unpairedAccess=false).
    if (
      category === "sentinel" &&
      set.size === 1 &&
      set.has("playback") &&
      !unpairedAccess
    ) {
      return { ok: false, goodbye: "pairing_required" };
    }
    return { ok: false, goodbye: "unauthorized" };
  }

  // Only a playback-capable connection may carry non-empty active_roles. A connection
  // is playback-capable when its activities extended with 'playback' are still an
  // allowed set for the matched PSK.
  if (activeRoles && activeRoles.length > 0) {
    const withPlayback = new Set(set);
    withPlayback.add("playback");
    if (!isAllowedActivitySet(category, withPlayback, unpairedAccess)) {
      return { ok: false, goodbye: "unauthorized" };
    }
  }

  return { ok: true };
}
