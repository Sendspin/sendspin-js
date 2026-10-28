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
  CLIENT_INIT = "client/init",
  SERVER_INIT = "server/init",
  NOISE_HANDSHAKE = "noise/handshake",
  SERVER_ACTIVATE = "server/activate",
  CLIENT_PAIR_PENDING = "client/pair-pending",
  CLIENT_PAIR_INIT = "client/pair-init",
  SERVER_PAIR_INIT = "server/pair-init",
  SERVER_PAIR_AUTH = "server/pair-auth",
  CLIENT_PAIR_AUTH = "client/pair-auth",
  SERVER_PAIR_CONFIRM = "server/pair-confirm",
  CLIENT_PAIR_RETRY = "client/pair-retry",
  CLIENT_PAIR_CONFIRM = "client/pair-confirm",
  CLIENT_PAIR_FINALIZE = "client/pair-finalize",
  SERVER_PAIR_FINALIZE = "server/pair-finalize",
  PAIR_ABORT = "pair/abort",
  SERVER_UNPAIR = "server/unpair",
}

/**
 * Reason for client disconnect.
 * - 'another_server': Client is switching to a different Sendspin server
 * - 'shutdown': Client is shutting down
 * - 'restart': Client is restarting and will reconnect
 * - 'user_request': User explicitly requested to disconnect
 * - 'unauthorized': Client failed authentication/pairing
 * - 'pairing_required': Server requires pairing before continuing
 * - 'concurrent_attempt': Another pairing attempt is already in progress
 * - 'unpaired': Server unpaired the client
 */
export type GoodbyeReason =
  | "another_server"
  | "shutdown"
  | "restart"
  | "user_request"
  | "unauthorized"
  | "pairing_required"
  | "concurrent_attempt"
  | "unpaired";

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
  seek: { position_ms: number };
  seek_relative: { offset_ms: number };
}

export type ControllerCommand = keyof ControllerCommands;

export interface ClientHello {
  type: MessageType.CLIENT_HELLO;
  payload: {
    name: string;
    supported_roles: string[];
    supported_pair_methods: SupportedPairMethods;
    unpaired_access: { enabled: boolean };
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
    available: boolean;
    player?: {
      volume?: number;
      muted?: boolean;
      output_delay_ms: number;
      required_lead_time_ms: number;
      min_buffer_ms: number;
      supported_commands: Array<"volume" | "mute" | "set_output_delay">;
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
      position_ms?: number;
      offset_ms?: number;
    };
  };
}

export interface ServerHello {
  type: MessageType.SERVER_HELLO;
  payload: {
    name: string;
    languages?: string[];
    /**
     * Present only when the server supports the source@v1 role, which this SDK
     * does not implement. Lists the codecs the server accepts in
     * client-stream/start; always includes flac and pcm, and may include
     * identifiers unknown to this SDK.
     */
    "source@v1_support"?: {
      supported_codecs: string[];
    };
  };
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
  timestamp: number;
  title?: string;
  artist?: string;
  album_artist?: string;
  album?: string;
  artwork_url?: string;
  year?: number;
  track?: number;
  progress?: {
    track_progress: number;
    track_duration: number;
    playback_speed: number;
  };
}

export interface ServerStateController {
  supported_commands: string[];
  volume: number;
  muted: boolean;
  repeat: "off" | "one" | "all";
  shuffle: boolean;
  seek_max_ms?: number;
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
      command: "volume" | "mute" | "set_output_delay";
      volume?: number;
      mute?: boolean;
      output_delay_ms?: number;
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

export type PairMethod =
  "pairing_psk" | "dynamic_pairing_code" | "static_pairing_code";

/** Out-channels through which a client can convey the dynamic pairing code. */
export type PairOutChannel = "display" | "speaker";

/** Emission formats of the dynamic pairing code. */
export type PairCodeFormat = "digits" | "qr_code";

/** Where the operator can find a static pairing secret. */
export type PairSecretLocation = "device" | "leaflet" | "operator";

/** client/hello supported_pair_methods: the offered methods, keyed by method. */
export interface SupportedPairMethods {
  pairing_psk: { locations?: PairSecretLocation[] };
  static_pairing_code?: { locations?: PairSecretLocation[] };
  dynamic_pairing_code?: {
    out_channels: PairOutChannel[];
    formats: PairCodeFormat[];
  };
}

export interface ClientInit {
  type: MessageType.CLIENT_INIT;
  payload: { client_id: string; version: number; suite: string };
}

export interface ServerInit {
  type: MessageType.SERVER_INIT;
  payload: { server_id: string; version: number };
}

export interface NoiseHandshake {
  type: MessageType.NOISE_HANDSHAKE;
  payload: { data: string };
}

/** Parameters of the pairing attempt a pairing server/activate admits. */
export interface ActivatePairing {
  method: PairMethod;
  /** Dynamic pairing code only: the emission format for this attempt. */
  format?: PairCodeFormat;
}

export interface ServerActivate {
  type: MessageType.SERVER_ACTIVATE;
  payload: {
    activities: Array<"playback" | "pairing">;
    active_roles?: string[];
    pairing?: ActivatePairing;
  };
}

export interface ClientPairPending {
  type: MessageType.CLIENT_PAIR_PENDING;
  payload: { pairing_index: number };
}

export interface ClientPairInit {
  type: MessageType.CLIENT_PAIR_INIT;
  /** commit_B (SHA-256 of nonce_B) is present in dynamic pairing, absent in static. */
  payload: { pairing_index: number; commit_B?: string };
}

export interface ServerPairInit {
  type: MessageType.SERVER_PAIR_INIT;
  /** nonce_A is present in the first round only. */
  payload: { nonce_A?: string };
}

export interface ServerPairAuth {
  type: MessageType.SERVER_PAIR_AUTH;
  payload: { pake_msg_1: string };
}

export interface ClientPairAuth {
  type: MessageType.CLIENT_PAIR_AUTH;
  payload: { pake_msg_2: string };
}

export interface ServerPairConfirm {
  type: MessageType.SERVER_PAIR_CONFIRM;
  payload: { server_kc: string };
}

export interface ClientPairRetry {
  type: MessageType.CLIENT_PAIR_RETRY;
  payload: Record<string, never>;
}

export interface ClientPairConfirm {
  type: MessageType.CLIENT_PAIR_CONFIRM;
  /** wrapped_nonce_B (sealed preimage of commit_B) is present in dynamic pairing only. */
  payload: { client_kc: string; wrapped_nonce_B?: string };
}

export interface ClientPairFinalize {
  type: MessageType.CLIENT_PAIR_FINALIZE;
  /** long_term_psk in the Pairing PSK flow, wrapped_psk when a PIN method sealed it. */
  payload: { long_term_psk: string } | { wrapped_psk: string };
}

export interface ServerPairFinalize {
  type: MessageType.SERVER_PAIR_FINALIZE;
  payload: Record<string, never>;
}

export type PairAbortReason =
  | "attempt_timeout"
  | "concurrent_attempt"
  | "method_not_supported"
  | "pairing_code_mismatch"
  | "user_cancelled";

export interface PairAbort {
  type: MessageType.PAIR_ABORT;
  payload: { reason: PairAbortReason };
}

export interface ServerUnpair {
  type: MessageType.SERVER_UNPAIR;
  payload: Record<string, unknown>;
}

export type ServerMessage =
  | ServerHello
  | ServerInit
  | NoiseHandshake
  | ServerActivate
  | ServerPairInit
  | ServerPairAuth
  | ServerPairConfirm
  | ServerPairFinalize
  | ServerUnpair
  | PairAbort
  | ServerTime
  | ServerState
  | StreamStart
  | StreamClear
  | StreamEnd
  | ServerCommand
  | GroupUpdate;

export type ClientMessage =
  ClientHello | ClientTime | ClientState | ClientCommand | ClientGoodbye;

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
 * - "sync": Multi-device sync, may use small playback-rate adjustments (capped at ±0.5%, inaudible) for faster convergence.
 * - "quality": No rate changes; uses sample fixes and tighter resyncs, so you get fewer adjustments but occasional jumps. Starts out of sync until the clock converges. Not recommended for bad networks.
 * - "quality-local": Avoids playback-rate changes; may drift vs. group sync and only resyncs as a last resort. Using this mode makes the player non-compliant with the Sendspin specification.
 */
export type CorrectionMode = "sync" | "quality" | "quality-local";

/**
 * Sync correction thresholds for a single correction mode.
 * All values are in milliseconds unless noted.
 */
export interface CorrectionThresholds {
  /** Hard resync when sync error exceeds this (ms) */
  resyncAboveMs: number;
  /** Use the firm (±0.5%) playback-rate tier when error exceeds this (ms). Infinity = disabled. */
  rate2AboveMs: number;
  /** Use the soft (±0.3%) playback-rate tier when error exceeds this (ms). Infinity = disabled. */
  rate1AboveMs: number;
  /** Use sample insertion/deletion when error is below this (ms). 0 = disabled. */
  samplesBelowMs: number;
  /** No correction when error is below this (ms) */
  deadbandBelowMs: number;
  /** Whether the recorrection monitor runs in this mode */
  enableRecorrectionMonitor: boolean;
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
   * - "sync" (default): Corrects out of sync playback using all methods, including small
   *   playback-rate adjustments capped at ±0.5% (inaudible) for faster convergence.
   *   Best for multi-device sync.
   * - "quality": No playback-rate changes; uses sample fixes and tighter resyncs, so expect fewer adjustments but occasional jumps. Starts out of sync until the clock converges. Not recommended for bad networks.
   * - "quality-local": Avoids playback-rate changes; may drift vs. other players and only resyncs
   *   as a last resort.
   *   Best for single-device playback where audio quality is priority. Using this mode makes the player non-compliant with the Sendspin specification.
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
   * Use automatic output latency compensation.
   * When enabled, reads AudioContext.baseLatency and outputLatency and applies
   * platform fallbacks where those APIs underreport the output path.
   *
   * Note: API reliability varies by browser/platform. But generally works well,
   * especially on modern mobile browsers.
   *
   * Default: true
   */
  useOutputLatencyCompensation?: boolean;
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
   * Called immediately before each reconnect attempt opens a new socket.
   * `attempt` is 1-based.
   */
  onReconnecting?: (attempt: number) => void;

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
  /**
   * Base URL of the Sendspin server (e.g., "http://192.168.1.100:8095").
   * Required unless webSocket is provided.
   */
  baseUrl?: string;

  /** Human-readable name for this player. Auto-generated if not provided. */
  clientName?: string;

  /** Product name advertised in client/hello. Omitted when not set. */
  productName?: string;

  /**
   * Codecs to use for audio streaming, in priority order.
   * Unsupported codecs for the current browser are automatically filtered out:
   * - Safari: No FLAC support
   * - Firefox: No Opus (audio glitches with both native and opus-encdec decoders)
   * - Browsers with WebCodecs (Chrome, Edge): All codecs
   * - Browsers without WebCodecs (e.g., insecure context or older browsers): No Opus
   *
   * Servers are only required to support FLAC and PCM, so when neither "flac"
   * nor "pcm" remains, both are appended (where the browser decodes them) as
   * lowest-priority fallbacks, "flac" first.
   *
   * Default: ["opus", "flac", "pcm"]
   */
  codecs?: Codec[];

  /**
   * Buffer capacity in bytes, advertised to the server as the amount of
   * not-yet-played encoded audio it may send ahead.
   *
   * Defaults to the server's stream-ahead depth at the worst-case byte rate of
   * the advertised formats (~5.8-5.9MB, as FLAC or PCM is always offered). Set
   * this only for clients with a real, smaller buffer.
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
   * Output delay in milliseconds.
   * Positive values make playback earlier to compensate for downstream device latency.
   * Allowed range: 0-5000.
   * Runtime update behavior depends on the active correction mode settings.
   * Falls back to a persisted value, then `defaultSyncDelay`, then 0.
   *
   * The default of 0 means audio leaves the audio output port at the instant the
   * server stamped it for, matching the protocol default. Only set this to
   * compensate for latency the SDK cannot see (an amplifier, external speakers,
   * a Bluetooth link), not for browser output latency, which is measured and
   * compensated automatically via `useOutputLatencyCompensation`.
   *
   * Server-commanded delays (set_output_delay) are persisted via `storage` and
   * restored on the next connect. Passing `syncDelay` explicitly overrides any
   * persisted value for that connect.
   */
  syncDelay?: number;

  /**
   * Fallback output delay used when neither `syncDelay` nor a persisted value
   * is available. Defaults to 0.
   * @internal
   */
  defaultSyncDelay?: number;

  /**
   * Storage for persisting SDK state: the identity key, the Pairing PSK,
   * paired server keys, the pairing round count, cached output latency and
   * the server-commanded output delay. Keys are stored as plain text.
   * SendspinCore persists only when this is provided. SendspinPlayer defaults
   * it to localStorage. Pass null to disable persistence.
   */
  storage?: SendspinStorage | null;

  /**
   * Minimum startup lead time in milliseconds reported to the server via
   * client/state (codec init, decode warmup, audio backend buffering, DAC).
   * Can be updated at runtime via setRequiredLeadTimeMs.
   * Default: 250.
   */
  requiredLeadTimeMs?: number;

  /**
   * Requested minimum ongoing buffer duration in milliseconds reported to the
   * server via client/state, to absorb network jitter during playback.
   * Can be updated at runtime via setMinBufferMs.
   * Default: 250.
   */
  minBufferMs?: number;

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
   * Callback when server sends a set_output_delay command.
   * Called with the new output delay in milliseconds (0-5000).
   * The SDK persists the value via `storage` before invoking this callback.
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

  /** Preferred Noise cipher suite. Default "chacha". */
  suite?: "chacha" | "aesgcm";

  /**
   * Whether to admit unpaired (Sentinel-PSK) playback. Reported in
   * client/hello.unpaired_access.enabled. Default true.
   *
   * Unpaired playback authenticates with the well-known Sentinel PSK, so it is
   * exposed to an active MITM. Set false to require pairing before any playback.
   */
  unpairedAccess?: boolean;

  /**
   * Pre-provisioned long-term PSK records (base64url psk and the serverId it is bound to).
   */
  longTermPsks?: Array<{ psk: string; serverId: string }>;

  /**
   * Callback for pairing lifecycle events. "pending" means the attempt is
   * held back, waiting for openPairingWindow() or releasePairingHold().
   */
  onPairing?: (
    event: "pending" | "started" | "finalized" | "aborted",
    detail?: string,
  ) => void;

  /**
   * Setting it turns on dynamic code pairing.
   * Called with a code to show or speak to the operator, who enters it on the
   * server. Called again with the same code in each new round after a wrong
   * entry, so speak it again then.
   * Called with null when the attempt ends, so hide the code then.
   * languages lists the operator's preferred languages for speaking it, most
   * preferred first, if the server sent any.
   * Avoid setting both this and staticPairingCode.
   */
  onPairingCode?: (code: string | null, languages?: string[]) => void;

  /**
   * How the app presents the pairing code. Default ["display"].
   * Add "speaker" only if the app reads the code aloud in the languages
   * passed to onPairingCode.
   */
  pairingCodeOutChannels?: PairOutChannel[];

  /**
   * This device's fixed 8-digit pairing code, for devices with no display or
   * speaker. Setting it turns on static code pairing.
   * Use a secure random code that is unique to each device.
   * Attempts wait for openPairingWindow().
   * Avoid setting both this and onPairingCode.
   */
  staticPairingCode?: string;

  /** Where the operator finds the static pairing code. Omitted when unset. */
  staticPairingCodeLocations?: PairSecretLocation[];

  /**
   * Where the operator finds the Pairing PSK. Omitted when unset.
   * Print it only as a QR code of pairingToken.
   */
  pairingPskLocations?: PairSecretLocation[];

  /** Callback when player state changes (local or from server). */
  onStateChange?: (state: {
    isPlaying: boolean;
    volume: number;
    muted: boolean;
    playerState: PlayerState;
    /** Cached server state (latest role objects from server/state messages) */
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
