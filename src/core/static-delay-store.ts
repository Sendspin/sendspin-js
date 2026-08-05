/**
 * Persists the server-commanded static delay so it survives reboots and
 * reconnections, as the spec requires.
 */

import type { SendspinStorage } from "../types";
import { clampSyncDelayMs } from "../sync-delay";

// Ignore delays saved before fixed scheduling headroom was removed (#159).
const STATIC_DELAY_STORAGE_KEY = "sendspin-static-delay-ms-v2";

export class StaticDelayStore {
  constructor(private storage: SendspinStorage | null) {}

  load(): number | null {
    if (!this.storage) return null;
    try {
      const stored = this.storage.getItem(STATIC_DELAY_STORAGE_KEY);
      if (stored === null) return null;
      const value = parseFloat(stored);
      if (isNaN(value)) return null;
      return clampSyncDelayMs(value);
    } catch {
      return null;
    }
  }

  save(delayMs: number): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STATIC_DELAY_STORAGE_KEY, delayMs.toString());
    } catch {
      // ignore
    }
  }
}
