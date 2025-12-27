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
    player_support?: {
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
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  artwork_url?: string | null;
  year?: number | null;
  track_number?: number | null;
  progress?: {
    position_ms: number;
    duration_ms: number;
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
      command: "volume" | "mute";
      volume?: number;
      mute?: boolean;
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

export interface SupportedFormat {
  codec: string;
  channels: number;
  sample_rate: number;
  bit_depth: number;
}

export interface SendspinPlayerConfig {
  /** Unique player identifier. Auto-generated if not provided. */
  playerId?: string;

  /** Base URL of the Sendspin server (e.g., "http://192.168.1.100:8095") */
  baseUrl: string;

  /** Human-readable name for this player. Auto-generated if not provided. */
  clientName?: string;

  /**
   * Audio output mode:
   * - "direct": Output directly to audioContext.destination (e.g., Cast receiver)
   * - "media-element": Use HTMLAudioElement for MediaSession support (e.g., mobile browsers)
   *
   * Default: "media-element" on iOS/Android, "direct" otherwise.
   */
  audioOutputMode?: AudioOutputMode;

  /**
   * HTMLAudioElement for media-element output mode.
   * Auto-created if not provided when using media-element mode.
   */
  audioElement?: HTMLAudioElement;

  /**
   * Whether running on Android (affects MediaSession workarounds).
   * Auto-detected from user agent if not provided.
   */
  isAndroid?: boolean;

  /**
   * Almost-silent audio data URL for Android MediaSession workaround.
   * Required for Android when using media-element mode.
   */
  silentAudioSrc?: string;

  /**
   * Codecs to use for audio streaming, in priority order.
   * Unsupported codecs for the current browser are automatically filtered out:
   * - Safari: No FLAC support
   * - Browsers without WebCodecs (Firefox Android, insecure context): No Opus
   * - Browsers with WebCodecs (Chrome, Edge, Firefox desktop): All codecs
   *
   * Default: ["opus", "flac", "pcm"]
   */
  codecs?: Codec[];

  /**
   * Buffer capacity in bytes. Defaults to 5MB for media-element, 1.5MB for direct.
   */
  bufferCapacity?: number;

  /**
   * Static sync delay in milliseconds.
   * Positive values delay playback, negative values advance it.
   * Use this to compensate for device-specific audio latency.
   */
  syncDelay?: number;

  /**
   * Use browser's output latency API for automatic latency compensation.
   * When enabled, reads AudioContext.baseLatency and outputLatency to
   * compensate for hardware delay (e.g., Bluetooth headphones).
   *
   * Note: API reliability varies by browser/platform. Works well on Android,
   * less reliable on desktop browsers.
   *
   * Default: false
   */
  useOutputLatencyCompensation?: boolean;

  /** Callback when player state changes (local or from server) */
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

  /**
   * Use hardware/external volume control instead of software gain.
   * When true, the internal gain node stays at 1.0 and volume commands
   * are delegated to the onVolumeCommand callback.
   */
  useHardwareVolume?: boolean;

  /**
   * Callback when server sends volume/mute commands.
   * Only called when useHardwareVolume is true.
   * The app should apply the volume to hardware (e.g., Cast system volume).
   */
  onVolumeCommand?: (volume: number, muted: boolean) => void;

  /**
   * Getter for external volume state.
   * Called when reporting state to server if useHardwareVolume is true.
   * Should return current hardware volume (0-100) and muted state.
   */
  getExternalVolume?: () => { volume: number; muted: boolean };
}

export interface AudioBufferQueueItem {
  buffer: AudioBuffer;
  serverTime: number;
  generation: number;
}
