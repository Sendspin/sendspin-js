// Sendspin Protocol Types and Interfaces

export enum MessageType {
  CLIENT_HELLO = "client/hello",
  SERVER_HELLO = "server/hello",
  CLIENT_TIME = "client/time",
  SERVER_TIME = "server/time",
  CLIENT_STATE = "client/state",
  SERVER_STATE = "server/state",
  CLIENT_COMMAND = "client/command",
  CLIENT_GOODBYE = "client/goodbye",
  SERVER_COMMAND = "server/command",
  STREAM_START = "stream/start",
  STREAM_CLEAR = "stream/clear",
  STREAM_REQUEST_FORMAT = "stream/request-format",
  STREAM_END = "stream/end",
  GROUP_UPDATE = "group/update",
}

/**
 * Reason for client disconnect.
 * - 'another_server': Client is switching to a different Sendspin server
 * - 'shutdown': Client is shutting down
 * - 'restart': Client is restarting and will reconnect
 * - 'user_request': User explicitly requested to disconnect
 */
export type GoodbyeReason =
  | "another_server"
  | "shutdown"
  | "restart"
  | "user_request";

/**
 * Map of controller commands to their required parameters.
 * Commands with `void` require no parameters.
 */
export interface ControllerCommands {
  play: void;
  pause: void;
  stop: void;
  next: void;
  previous: void;
  volume: { volume: number };
  mute: { mute: boolean };
  repeat_off: void;
  repeat_one: void;
  repeat_all: void;
  shuffle: void;
  unshuffle: void;
  switch: void;
}

export type ControllerCommand = keyof ControllerCommands;

export interface ClientHello {
  type: MessageType.CLIENT_HELLO;
  payload: {
    client_id: string;
    name: string;
    version: number;
    supported_roles: string[];
    device_info?: {
      product_name?: string;
      manufacturer?: string;
      software_version?: string;
    };
    "player@v1_support"?: {
      supported_formats: Array<{
        codec: string;
        channels: number;
        sample_rate: number;
        bit_depth: number;
      }>;
      buffer_capacity: number;
      supported_commands: string[];
    };
  };
}

export interface ClientTime {
  type: MessageType.CLIENT_TIME;
  payload: {
    client_transmitted: number;
  };
}

export interface ClientState {
  type: MessageType.CLIENT_STATE;
  payload: {
    player?: {
      state: "synchronized" | "error";
      volume: number;
      muted: boolean;
      static_delay_ms: number;
      supported_commands?: string[];
    };
  };
}

export interface ClientGoodbye {
  type: MessageType.CLIENT_GOODBYE;
  payload: {
    reason: GoodbyeReason;
  };
}

export interface ClientCommand {
  type: MessageType.CLIENT_COMMAND;
  payload: {
    controller: {
      command: ControllerCommand;
      volume?: number;
      mute?: boolean;
    };
  };
}

export interface ServerHello {
  type: MessageType.SERVER_HELLO;
  payload: Record<string, unknown>;
}

export interface ServerTime {
  type: MessageType.SERVER_TIME;
  payload: {
    client_transmitted: number;
    server_received: number;
    server_transmitted: number;
  };
}

export interface ServerStateMetadata {
  timestamp?: number;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  artwork_url?: string | null;
  year?: number | null;
  track_number?: number | null;
  progress?: {
    track_progress: number;
    track_duration: number;
    playback_speed: number;
  } | null;
  repeat?: "off" | "one" | "all" | null;
  shuffle?: boolean | null;
}

export interface ServerStateController {
  supported_commands?: string[];
  volume?: number;
  muted?: boolean;
}

export interface ServerStatePlayer {
  // Player-specific state from server
}

export interface ServerStatePayload {
  metadata?: ServerStateMetadata;
  controller?: ServerStateController;
  player?: ServerStatePlayer;
}

export interface ServerState {
  type: MessageType.SERVER_STATE;
  payload: ServerStatePayload;
}

export interface StreamStart {
  type: MessageType.STREAM_START;
  payload: {
    player: {
      codec: string;
      sample_rate: number;
      channels: number;
      bit_depth?: number;
      codec_header?: string;
    };
  };
}

export interface StreamClear {
  type: MessageType.STREAM_CLEAR;
  payload: {
    roles?: string[];
  };
}

export interface StreamEnd {
  type: MessageType.STREAM_END;
  payload: {
    roles?: string[];
  };
}

export interface ServerCommand {
  type: MessageType.SERVER_COMMAND;
  payload: {
    player: {
      command: "volume" | "mute" | "set_static_delay";
      volume?: number;
      mute?: boolean;
      static_delay_ms?: number;
    };
  };
}

export interface GroupUpdatePayload {
  playback_state?: "playing" | "stopped";
  group_id?: string;
  group_name?: string;
}

export interface GroupUpdate {
  type: MessageType.GROUP_UPDATE;
  payload: GroupUpdatePayload;
}

export type ServerMessage =
  | ServerHello
  | ServerTime
  | ServerState
  | StreamStart
  | StreamClear
  | StreamEnd
  | ServerCommand
  | GroupUpdate;

export type ClientMessage =
  | ClientHello
  | ClientTime
  | ClientState
  | ClientCommand
  | ClientGoodbye;

export type StreamFormat = {
  codec: string;
  sample_rate: number;
  channels: number;
  bit_depth?: number;
  codec_header?: string;
};

export type PlayerState = "synchronized" | "error";

export type AudioOutputMode = "direct" | "media-element";

export type Codec = "pcm" | "opus" | "flac";

/**
 * Audio sync correction mode:
 * - "sync": Multi-device sync, may use pitch-changing playback-rate adjustments for faster convergence.
 * - "quality": No rate changes; uses sample fixes and tighter resyncs, so you get fewer adjustments but occasional jumps. Starts out of sync until the clock converges. Not recommended for bad networks.
 * - "quality-local": Avoids playback-rate changes; may drift vs. group sync and only resyncs as a last resort.
 */
export type CorrectionMode = "sync" | "quality" | "quality-local";

/**
 * Sync correction thresholds for a single correction mode.
 * All values are in milliseconds unless noted.
 */
export interface CorrectionThresholds {
  /** Hard resync when sync error exceeds this (ms) */
  resyncAboveMs: number;
  /** Use ±2% playback rate when error exceeds this (ms). Infinity = disabled. */
  rate2AboveMs: number;
  /** Use ±1% playback rate when error exceeds this (ms). Infinity = disabled. */
  rate1AboveMs: number;
  /** Use sample insertion/deletion when error is below this (ms). 0 = disabled. */
  samplesBelowMs: number;
  /** No correction when error is below this (ms) */
  deadbandBelowMs: number;
  /** Whether the recorrection monitor runs in this mode */
  enableRecorrectionMonitor: boolean;
  /** Whether runtime sync delay changes trigger immediate cutover */
  immediateDelayCutover: boolean;
}

export interface SupportedFormat {
  codec: string;
  channels: number;
  sample_rate: number;
  bit_depth: number;
}

export interface SendspinPlayerConfig extends SendspinCoreConfig {
  /**
   * HTMLAudioElement for media-element output mode.
   * Auto-created on mobile browsers if not provided.
   */
  audioElement?: HTMLAudioElement;

  /**
   * Sync correction mode:
   * - "sync" (default): Corrects out of sync playback using all methods and may use pitch-changing
   *   playback-rate adjustments for faster convergence.
   *   Best for multi-device sync but may cause audible pitch shifts, especially just
   *   after starting of playback.
   * - "quality": No playback-rate changes; uses sample fixes and tighter resyncs, so expect fewer adjustments but occasional jumps. Starts out of sync until the clock converges. Not recommended for bad networks.
   * - "quality-local": Avoids playback-rate changes; may drift vs. other players and only resyncs
   *   as a last resort.
   *   Best for single-device playback where audio quality is priority.
   */
  correctionMode?: CorrectionMode;

  /**
   * Override default correction thresholds per mode.
   * Partially override any mode — unspecified fields keep their defaults.
   *
   * @example
   * // Make "sync" mode tolerate more drift before hard resyncing
   * correctionThresholds: { sync: { resyncAboveMs: 400 } }
   */
  correctionThresholds?: Partial<
    Record<CorrectionMode, Partial<CorrectionThresholds>>
  >;

  /**
   * Use browser's output latency API for automatic latency compensation.
   * When enabled, reads AudioContext.baseLatency and outputLatency to
   * compensate for hardware delay (e.g., Bluetooth headphones).
   *
   * Note: API reliability varies by browser/platform. But generally works well,
   * especially on modern mobile browsers.
   *
   * Default: true
   */
  useOutputLatencyCompensation?: boolean;

  /**
   * Storage for persisting SDK state (e.g., cached output latency).
   * Defaults to localStorage. Pass null to disable persistence.
   */
  storage?: SendspinStorage | null;
}

/**
 * A decoded audio chunk with raw PCM samples.
 * Emitted by SendspinCore after decoding compressed audio.
 * Consumed by SendspinPlayer for playback, or by visualization/analysis tools.
 */
export interface DecodedAudioChunk {
  /** PCM sample data, one Float32Array per channel (values in -1.0 to 1.0) */
  samples: Float32Array[];
  /** Sample rate in Hz */
  sampleRate: number;
  /** Server timestamp in microseconds */
  serverTimeUs: number;
  /** Stream generation (incremented on each new stream) */
  generation: number;
}

/**
 * Information about a reconnect attempt.
 */
export interface ReconnectAttemptInfo {
  /** 1-based attempt counter. */
  attempt: number;
  /** Delay (ms) before this attempt fires. */
  delayMs: number;
}

/**
 * Reconnection behavior when the WebSocket closes unexpectedly.
 *
 * Defaults: exponential backoff starting at 1s, capped at 15s, unlimited attempts.
 * Reconnection is only active for connections opened via `baseUrl` — adopted
 * sockets (via `webSocket`) never auto-reconnect.
 */
export interface ReconnectConfig {
  /**
   * Base delay in ms for the first reconnect attempt.
   * Subsequent attempts double this up to `maxDelayMs`.
   *
   * Default: 1000
   */
  baseDelayMs?: number;

  /**
   * Upper bound for the exponential backoff delay in ms.
   *
   * Default: 15000
   */
  maxDelayMs?: number;

  /**
   * Maximum number of reconnect attempts before giving up and firing
   * `onExhausted`. Pass `Infinity` for unlimited retries.
   *
   * Default: Infinity
   */
  maxAttempts?: number;

  /**
   * Called before each reconnect attempt fires (after the delay has elapsed
   * but before the WebSocket is created).
   */
  onReconnecting?: (info: ReconnectAttemptInfo) => void;

  /**
   * Called once the socket re-opens successfully after one or more retries.
   */
  onReconnected?: () => void;

  /**
   * Called when `maxAttempts` is reached without a successful reconnect.
   * After this fires, the manager stops retrying automatically.
   */
  onExhausted?: () => void;
}

/**
 * Configuration for SendspinCore (protocol + decoding, no playback).
 */
export interface SendspinCoreConfig {
  /** Unique player identifier. Auto-generated if not provided. */
  playerId?: string;

  /**
   * Base URL of the Sendspin server (e.g., "http://192.168.1.100:8095").
   * Required unless webSocket is provided.
   */
  baseUrl?: string;

  /** Human-readable name for this player. Auto-generated if not provided. */
  clientName?: string;

  /**
   * Codecs to use for audio streaming, in priority order.
   * Unsupported codecs for the current browser are automatically filtered out:
   * - Safari: No FLAC support
   * - Firefox: No Opus (audio glitches with both native and opus-encdec decoders)
   * - Browsers with WebCodecs (Chrome, Edge): All codecs
   * - Browsers without WebCodecs (e.g., insecure context or older browsers): No Opus
   *
   * Default: ["opus", "flac", "pcm"]
   */
  codecs?: Codec[];

  /**
   * Buffer capacity in bytes. Defaults to 5MB for media-element, 1.5MB for direct.
   */
  bufferCapacity?: number;

  /**
   * Pre-established WebSocket connection.
   * When provided, the core adopts this socket instead of creating one from baseUrl.
   * The socket must connect to the Sendspin /sendspin endpoint.
   * Auto-reconnect is disabled for externally-managed sockets.
   */
  webSocket?: WebSocket;

  /**
   * Static sync delay in milliseconds.
   * Positive values make playback earlier to compensate for downstream device latency.
   * Allowed range: 0-5000.
   * Runtime update behavior depends on the active correction mode settings.
   * Defaults to a browser/platform-specific heuristic value if not provided.
   */
  syncDelay?: number;

  /**
   * Use hardware/external volume control instead of software gain.
   * When true, the internal gain node stays at 1.0 and volume commands
   * are delegated to the onVolumeCommand callback.
   *
   * Default: false
   */
  useHardwareVolume?: boolean;

  /**
   * Callback when server sends volume/mute commands.
   * Only called when useHardwareVolume is true.
   * The app should apply the volume to hardware (e.g., Cast system volume).
   */
  onVolumeCommand?: (volume: number, muted: boolean) => void;

  /**
   * Callback when server sends a set_static_delay command.
   * Called with the new static delay in milliseconds (0-5000).
   */
  onDelayCommand?: (delayMs: number) => void;

  /**
   * Getter for external volume state.
   * Called periodically when reporting state to server if useHardwareVolume is true.
   * Should return current hardware volume (0-100) and muted state.
   * Not called immediately after volume commands to wait for hardware to apply the change.
   */
  getExternalVolume?: () => { volume: number; muted: boolean };

  /**
   * Reconnection behavior for connections opened via `baseUrl`.
   * See {@link ReconnectConfig} for defaults.
   */
  reconnect?: ReconnectConfig;

  /** Callback when player state changes (local or from server). */
  onStateChange?: (state: {
    isPlaying: boolean;
    volume: number;
    muted: boolean;
    playerState: PlayerState;
    /** Cached server state (merged from server/state messages) */
    serverState: ServerStatePayload;
    /** Cached group state (merged from group/update messages) */
    groupState: GroupUpdatePayload;
  }) => void;
}

/**
 * Storage interface for persisting SDK state.
 * Compatible with Web Storage API (localStorage/sessionStorage).
 * Provide a custom implementation to control where the SDK stores data.
 */
export interface SendspinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
