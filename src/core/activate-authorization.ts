import type { PskCategory } from "./noise/psk";
import type { GoodbyeReason } from "../types";

export type AuthResult =
  { ok: true; activeRoles: string[] } | { ok: false; goodbye: GoodbyeReason };

function isAllowedActivitySet(
  category: PskCategory,
  activities: readonly string[],
  unpairedAccess: boolean,
): boolean {
  if (activities.some((a) => a !== "playback" && a !== "pairing")) {
    return false;
  }
  if (category === "long_term") return !activities.includes("pairing");
  return unpairedAccess || !activities.includes("playback");
}

function isPlaybackCapable(
  category: PskCategory,
  activities: readonly string[],
  unpairedAccess: boolean,
): boolean {
  return isAllowedActivitySet(
    category,
    [...activities, "playback"],
    unpairedAccess,
  );
}

function isAdmissible(
  category: PskCategory,
  activities: readonly string[],
  activeRoles: readonly string[],
  unpairedAccess: boolean,
): boolean {
  if (!isAllowedActivitySet(category, activities, unpairedAccess)) return false;
  return (
    activeRoles.length === 0 ||
    isPlaybackCapable(category, activities, unpairedAccess)
  );
}

/** Checks a server/activate and resolves its effective active_roles. */
export function authorizeActivate(
  category: PskCategory,
  activities: readonly string[],
  activeRoles: readonly string[] | undefined,
  persistedRoles: readonly string[],
  unpairedAccess: boolean,
): AuthResult {
  // The activation's `pairing` object is ignored unless 'pairing' is in
  // activities, so it never bears on authorization.
  const roles =
    activeRoles ??
    (isPlaybackCapable(category, activities, unpairedAccess)
      ? persistedRoles
      : []);

  if (isAdmissible(category, activities, roles, unpairedAccess)) {
    return { ok: true, activeRoles: [...roles] };
  }
  if (
    category !== "long_term" &&
    !unpairedAccess &&
    isAdmissible(category, activities, roles, true)
  ) {
    return { ok: false, goodbye: "pairing_required" };
  }
  return { ok: false, goodbye: "unauthorized" };
}
