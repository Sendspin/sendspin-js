import type { PskCategory } from "./noise/psk";
import type {
  ActivatePairing,
  GoodbyeReason,
  SupportedPairMethods,
} from "../types";

export type AuthResult =
  | { ok: true; activeRoles: string[] }
  | { ok: false; goodbye: GoodbyeReason }
  | { ok: false; pairAbort: "method_not_supported"; activeRoles: string[] }
  | { ok: false; protocolError: true };

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

function isMissingPairingField(
  activities: readonly string[],
  pairing: ActivatePairing | undefined,
): boolean {
  if (!activities.includes("pairing")) return false;
  if (!pairing?.method) return true;
  return (
    pairing.method === "dynamic_pairing_code" &&
    typeof pairing.format !== "string"
  );
}

function isAllowedPairing(
  category: PskCategory,
  activities: readonly string[],
  pairing: ActivatePairing | undefined,
  offered: SupportedPairMethods,
): boolean {
  if (!activities.includes("pairing")) return true;
  const { method, format } = pairing!;
  if ((method === "pairing_psk") !== (category === "pairing")) return false;
  if (!Object.keys(offered).includes(method)) return false;
  return (
    method !== "dynamic_pairing_code" ||
    offered.dynamic_pairing_code!.formats.includes(format!)
  );
}

/** Checks a server/activate and resolves its effective active_roles. */
export function authorizeActivate(
  category: PskCategory,
  activities: readonly string[],
  activeRoles: readonly string[] | undefined,
  persistedRoles: readonly string[],
  unpairedAccess: boolean,
  pairing: ActivatePairing | undefined,
  offered: SupportedPairMethods,
): AuthResult {
  if (isMissingPairingField(activities, pairing)) {
    return { ok: false, protocolError: true };
  }
  const roles =
    activeRoles ??
    (isPlaybackCapable(category, activities, unpairedAccess)
      ? persistedRoles
      : []);

  const pairingAllowed = isAllowedPairing(
    category,
    activities,
    pairing,
    offered,
  );

  if (
    pairingAllowed &&
    isAdmissible(category, activities, roles, unpairedAccess)
  ) {
    return { ok: true, activeRoles: [...roles] };
  }
  if (
    category !== "long_term" &&
    !unpairedAccess &&
    pairingAllowed &&
    isAdmissible(category, activities, roles, true)
  ) {
    return { ok: false, goodbye: "pairing_required" };
  }
  if (!isAdmissible(category, activities, roles, unpairedAccess)) {
    return { ok: false, goodbye: "unauthorized" };
  }
  // Keep the persisted roles only while the matched PSK allows any roles.
  return {
    ok: false,
    pairAbort: "method_not_supported",
    activeRoles: isPlaybackCapable(category, [], unpairedAccess)
      ? [...persistedRoles]
      : [],
  };
}
