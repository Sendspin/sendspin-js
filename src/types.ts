// Sendspin Protocol Types and Interfaces

export enum MessageType {
  CLIENT_HELLO = "client/hello",
  SERVER_HELLO = "server/hello",
  CLIENT_TIME = "client/time",
  SERVER_TIME = "server/time",
  CLIENT_STATE = "client/state",
  SERVER_STATE = "server/state",
  SERVER_COMMAND = "server/command",
  STREAM_START = "stream/start",
  STREAM_CLEAR = "stream/clear",
  STREAM_REQUEST_FORMAT = "stream/request-format",
  STREAM_END = "stream/end",
  GROUP_UPDATE = "group/update",
}

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

export interface ServerState {
  type: MessageType.SERVER_STATE;
  payload: Record<string, unknown>;
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

export interface GroupUpdate {
  type: MessageType.GROUP_UPDATE;
  payload: Record<string, unknown>;
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

export type ClientMessage = ClientHello | ClientTime | ClientState;

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
  /** Unique player identifier */
  playerId: string;

  /** Base URL of the Sendspin server (e.g., "http://192.168.1.100:8095") */
  baseUrl: string;

  /** Human-readable name for this player */
  clientName?: string;

  /**
   * Audio output mode:
   * - "direct": Output directly to audioContext.destination (e.g., Cast receiver)
   * - "media-element": Use HTMLAudioElement for MediaSession support (e.g., mobile browsers)
   */
  audioOutputMode?: AudioOutputMode;

  /**
   * HTMLAudioElement for media-element output mode.
   * Required when audioOutputMode is "media-element".
   */
  audioElement?: HTMLAudioElement;

  /**
   * Whether running on Android (affects MediaSession workarounds).
   * Only relevant for "media-element" output mode.
   */
  isAndroid?: boolean;

  /**
   * Almost-silent audio data URL for Android MediaSession workaround.
   * Required for Android when audioOutputMode is "media-element".
   */
  silentAudioSrc?: string;

  /**
   * Codecs to use for audio streaming, in priority order.
   * Unsupported codecs for the current browser are automatically filtered out:
   * - Safari: No FLAC support
   * - Firefox: No Opus support (libopus has audio glitches)
   * - Chromium: All codecs supported
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

  /** Callback when player state changes */
  onStateChange?: (state: {
    isPlaying: boolean;
    volume: number;
    muted: boolean;
    playerState: PlayerState;
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
