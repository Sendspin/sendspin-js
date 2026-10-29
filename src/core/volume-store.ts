/**
 * Persists the player volume and mute state so they survive reboots, as the
 * spec recommends.
 */

import type { SendspinStorage } from "../types";

const VOLUME_STORAGE_KEY = "sendspin-volume";
const MUTED_STORAGE_KEY = "sendspin-muted";

export class VolumeStore {
  constructor(private storage: SendspinStorage | null) {}

  load(): { volume: number | null; muted: boolean | null } {
    if (!this.storage) return { volume: null, muted: null };
    try {
      const volume = parseFloat(this.storage.getItem(VOLUME_STORAGE_KEY) ?? "");
      const muted = this.storage.getItem(MUTED_STORAGE_KEY);
      return {
        volume: isNaN(volume) ? null : volume,
        muted: muted === "true" ? true : muted === "false" ? false : null,
      };
    } catch {
      return { volume: null, muted: null };
    }
  }

  saveVolume(volume: number): void {
    this.save(VOLUME_STORAGE_KEY, volume.toString());
  }

  saveMuted(muted: boolean): void {
    this.save(MUTED_STORAGE_KEY, muted.toString());
  }

  private save(key: string, value: string): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(key, value);
    } catch {
      // ignore
    }
  }
}
