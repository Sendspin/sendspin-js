import type {
  PlayerState,
  StreamFormat,
  ServerStatePayload,
  GroupUpdatePayload,
} from "./types";

/**
 * Apply a diff to an object, returning a new copy.
 * - Fields from diff are merged into the copy
 * - null values delete the key from the result
 * - Nested objects are merged recursively (one level deep)
 */
function applyDiff<T extends object>(existing: T, diff: Partial<T>): T {
  const result = { ...existing };
  for (const key of Object.keys(diff) as (keyof T)[]) {
    const value = diff[key];
    if (value === null) {
      delete result[key];
    } else if (value !== undefined) {
      // If both existing and new value are plain objects, merge recursively
      const existingValue = result[key];
      if (
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof existingValue === "object" &&
        existingValue !== null &&
        !Array.isArray(existingValue)
      ) {
        result[key] = applyDiff(existingValue as object, value as object) as T[keyof T];
      } else {
        result[key] = value as T[keyof T];
      }
    }
  }
  return result;
}

export class StateManager {
  private _volume: number = 100;
  private _muted: boolean = false;
  private _playerState: PlayerState = "synchronized";
  private _isPlaying: boolean = false;
  private _currentStreamFormat: StreamFormat | null = null;
  private _streamStartServerTime: number = 0;
  private _streamStartAudioTime: number = 0;
  private _streamGeneration: number = 0;

  // Cached server state (from server/state messages)
  private _serverState: ServerStatePayload = {};

  // Cached group state (from group/update messages)
  private _groupState: GroupUpdatePayload = {};

  // Interval references for cleanup
  private timeSyncInterval: number | null = null;
  private stateUpdateInterval: number | null = null;

  // Callback for state changes
  private onStateChangeCallback?: (state: {
    isPlaying: boolean;
    volume: number;
    muted: boolean;
    playerState: PlayerState;
    serverState: ServerStatePayload;
    groupState: GroupUpdatePayload;
  }) => void;

  constructor(
    onStateChange?: (state: {
      isPlaying: boolean;
      volume: number;
      muted: boolean;
      playerState: PlayerState;
      serverState: ServerStatePayload;
      groupState: GroupUpdatePayload;
    }) => void,
  ) {
    this.onStateChangeCallback = onStateChange;
  }

  // Volume & Mute
  get volume(): number {
    return this._volume;
  }

  set volume(value: number) {
    this._volume = Math.max(0, Math.min(100, value));
    this.notifyStateChange();
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(value: boolean) {
    this._muted = value;
    this.notifyStateChange();
  }

  // Player State
  get playerState(): PlayerState {
    return this._playerState;
  }

  set playerState(value: PlayerState) {
    this._playerState = value;
    this.notifyStateChange();
  }

  // Playing State
  get isPlaying(): boolean {
    return this._isPlaying;
  }

  set isPlaying(value: boolean) {
    this._isPlaying = value;
    this.notifyStateChange();
  }

  // Stream Format
  get currentStreamFormat(): StreamFormat | null {
    return this._currentStreamFormat;
  }

  set currentStreamFormat(value: StreamFormat | null) {
    this._currentStreamFormat = value;
  }

  // Stream Anchoring (for timestamp-based scheduling)
  get streamStartServerTime(): number {
    return this._streamStartServerTime;
  }

  set streamStartServerTime(value: number) {
    this._streamStartServerTime = value;
  }

  get streamStartAudioTime(): number {
    return this._streamStartAudioTime;
  }

  set streamStartAudioTime(value: number) {
    this._streamStartAudioTime = value;
  }

  // Reset stream anchors (called on stream start)
  resetStreamAnchors(): void {
    this._streamStartServerTime = 0;
    this._streamStartAudioTime = 0;
    this._streamGeneration++;
  }

  // Get current stream generation
  get streamGeneration(): number {
    return this._streamGeneration;
  }

  // Interval management
  setTimeSyncInterval(interval: number): void {
    this.clearTimeSyncInterval();
    this.timeSyncInterval = interval;
  }

  clearTimeSyncInterval(): void {
    if (this.timeSyncInterval !== null) {
      clearTimeout(this.timeSyncInterval);
      this.timeSyncInterval = null;
    }
  }

  setStateUpdateInterval(interval: number): void {
    this.clearStateUpdateInterval();
    this.stateUpdateInterval = interval;
  }

  clearStateUpdateInterval(): void {
    if (this.stateUpdateInterval !== null) {
      clearInterval(this.stateUpdateInterval);
      this.stateUpdateInterval = null;
    }
  }

  clearAllIntervals(): void {
    this.clearTimeSyncInterval();
    this.clearStateUpdateInterval();
  }

  // Reset all state (called on disconnect)
  reset(): void {
    this._volume = 100;
    this._muted = false;
    this._playerState = "synchronized";
    this._isPlaying = false;
    this._currentStreamFormat = null;
    this._streamStartServerTime = 0;
    this._streamStartAudioTime = 0;
    this._serverState = {};
    this._groupState = {};
    this.clearAllIntervals();
  }

  // Notify callback of state changes
  private notifyStateChange(): void {
    if (this.onStateChangeCallback) {
      this.onStateChangeCallback({
        isPlaying: this._isPlaying,
        volume: this._volume,
        muted: this._muted,
        playerState: this._playerState,
        serverState: this._serverState,
        groupState: this._groupState,
      });
    }
  }

  // Update server state (merges delta, null clears fields)
  updateServerState(update: ServerStatePayload): void {
    this._serverState = applyDiff(this._serverState, update);
    this.notifyStateChange();
  }

  // Update group state (merges delta, null clears fields)
  updateGroupState(update: GroupUpdatePayload): void {
    this._groupState = applyDiff(this._groupState, update);
    this.notifyStateChange();
  }

  // Getters for cached state
  get serverState(): ServerStatePayload {
    return this._serverState;
  }

  get groupState(): GroupUpdatePayload {
    return this._groupState;
  }
}
