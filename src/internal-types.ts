/**
 * Internal plumbing types shared across SDK modules but not part of the
 * public API surface. These are intentionally NOT re-exported from index.ts.
 */

import type { StreamFormat } from "./types.js";

export interface AudioBufferQueueItem {
  buffer: AudioBuffer;
  serverTime: number;
  generation: number;
}

/**
 * Interface for protocol handler to call into the audio subsystem.
 * Implemented by SendspinCore as the bridge between protocol and audio.
 */
export interface StreamHandler {
  handleBinaryMessage(data: ArrayBuffer): void;
  handleStreamStart(format: StreamFormat, isFormatUpdate: boolean): void;
  handleStreamClear(fromTimestampUs?: number): void;
  handleStreamEnd(): void;
  handleVolumeUpdate(): void;
  handleSyncDelayChange(delayMs: number): void;
  getSyncDelayMs(): number;
}
