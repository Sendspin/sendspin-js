# CLAUDE.md

This file provides guidance for Claude Code when working with this repository.

## Project Overview

sendspin-js is a TypeScript SDK implementing the [Sendspin Protocol](https://www.sendspin-audio.com) for clock-synchronized audio streaming. It allows web applications to receive and play audio streams synchronized across multiple devices.

## Project Structure

```
sendspin-js/
├── src/                     # SDK source code (TypeScript)
│   ├── index.ts             # Main entry point, SendspinPlayer class
│   ├── types.ts             # Type definitions and interfaces
│   ├── audio-processor.ts   # Audio decoding and playback with sync
│   ├── protocol-handler.ts  # Sendspin protocol message handling
│   ├── state-manager.ts     # Player state management
│   ├── time-filter.ts       # Clock synchronization algorithm
│   └── websocket-manager.ts # WebSocket connection handling
├── dist/                    # Compiled SDK output
├── public/                  # Sample player assets
│   ├── app.js               # Sample player application code
│   └── styles.css           # Sample player styles
├── index.html               # Sample player HTML
└── package.json
```

## SDK Architecture

The SDK consists of these main components:

- **SendspinPlayer** (`src/index.ts`): Main public API class
- **AudioProcessor**: Handles audio decoding (PCM, Opus, FLAC) and synchronized playback
- **ProtocolHandler**: Implements the Sendspin protocol message exchange
- **StateManager**: Tracks player state (volume, muted, playing, etc.)
- **SendspinTimeFilter**: Clock synchronization using Kalman filtering
- **WebSocketManager**: WebSocket connection lifecycle

## Sample Player

The sample player (`index.html` + `public/app.js`) is a reference implementation demonstrating SDK usage.

### Development Server

```bash
yarn dev-server
```

Then browse to http://localhost:6001

## Testing

Tests in `tests/unit/` and `tests/e2e/`. E2E spawns the pinned upstream
aiosendspin server from `.venv` at the repo root. Run `./scripts/setup.sh`
once to bootstrap, then `yarn test`. One suite: `npx vitest run tests/unit`.

## Key SDK Features and Configuration

The `SendspinPlayerConfig` interface in `src/types.ts` defines all available options:

- `baseUrl`: Server URL
- `clientName`: Human-readable player name
- `productName`: Product name advertised in client/hello
- `audioOutputMode`: "direct" or "media-element" (for mobile)
- `audioElement`: Required for media-element mode
- `codecs`: Preferred codec order (opus, flac, pcm)
- `syncDelay`: Static sync delay in ms
- `useOutputLatencyCompensation`: Auto latency compensation
- `useHardwareVolume`: Delegate volume to hardware
- `onStateChange`: State change callback
- `onVolumeCommand`: Volume command callback (for hardware volume)

Encryption and pairing options:

- `suite`: Noise cipher suite, "chacha" (default) or "aesgcm"
- `unpairedAccess`: Admit unpaired playback on the Sentinel PSK
- `longTermPsks`: Preloaded long-term PSK records
- `storage`: Backing store for identity, PSKs, and PIN lockout counters
- `onPairing`: Pairing lifecycle callback
- `onPairingPin`: Enables dynamic PIN pairing, receives the derived PIN
- `minPinLength`: Shortest dynamic PIN this client accepts
- `staticPin`: Enables static PIN pairing with a fixed 8-digit PIN

## Sendspin Protocol Specification

The full protocol specification can be fetched from:
https://raw.githubusercontent.com/Sendspin/website/refs/heads/main/src/spec.md

## Important: Updating the Sample Player

When adding new features to the SDK, **always update the sample player** to demonstrate the feature:

1. Add UI controls in `index.html` if the feature is user-facing
2. Implement the feature usage in `public/app.js`
3. Update the code example in `README.md` to show API usage

This ensures the sample player serves as comprehensive documentation for all SDK capabilities.
