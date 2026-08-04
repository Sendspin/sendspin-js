# sendspin-js

[![npm](https://img.shields.io/npm/v/@sendspin/sendspin-js.svg)](https://www.npmjs.com/package/@sendspin/sendspin-js)

TypeScript client library implementing the [Sendspin Protocol](https://www.sendspin-audio.com) for clock-synchronized audio streaming.

See the SDK website to see Sendspin JS in action: https://sendspin.github.io/sendspin-js/

[![A project from the Open Home Foundation](https://www.openhomefoundation.org/badges/ohf-project.png)](https://www.openhomefoundation.org/)

## Example

```typescript
import { SendspinPlayer } from '@sendspin/sendspin-js';

const player = new SendspinPlayer({
  baseUrl: 'http://your-server:8095',
  clientName: 'My Web Player',
  // Advertised to the server as device_info.product_name. Defaults to
  // "Sendspin JS". Avoid "Web Browser": some servers treat that as their own
  // built-in player and skip pairing setup.
  productName: 'My App',
  // Optional: "sync" (default), "quality" (no pitch shifts; not recommended for bad networks),
  // or "quality-local" (best for unsynced playback)
  correctionMode: 'sync',
  onStateChange: (state) => {
    // Local player state
    console.log('Playing:', state.isPlaying);
    console.log('Volume:', state.volume, 'Muted:', state.muted);

    // Server state (metadata, controller info)
    if (state.serverState?.metadata) {
      const meta = state.serverState.metadata;
      console.log('Track:', meta.title, '-', meta.artist);
    }

    // Group state (playback state, group info)
    if (state.groupState) {
      console.log('Group:', state.groupState.group_name);
      console.log('Playback:', state.groupState.playback_state);
    }
  }
});

// Connect to server
await player.connect();

// Local volume control (affects this player only)
player.setVolume(80);
player.setMuted(false);

// Send commands to server (controls the source)
player.sendCommand('play');
player.sendCommand('pause');
player.sendCommand('stop');
player.sendCommand('next');
player.sendCommand('previous');
player.sendCommand('volume', { volume: 50 });
player.sendCommand('mute', { mute: true });
player.sendCommand('shuffle');
player.sendCommand('unshuffle');
player.sendCommand('repeat_off');
player.sendCommand('repeat_one');
player.sendCommand('repeat_all');
player.sendCommand('switch');  // Switch group

// Disconnect with reason (optional)
player.disconnect('user_request');
```

## Advanced configuration

### Bring your own WebSocket

Provide an already-open (or CONNECTING) `WebSocket` via `webSocket` to let the
player adopt it instead of creating a new one. Useful when the connection is
managed by a surrounding app framework. Auto-reconnect is disabled for adopted
sockets.

```typescript
const ws = new WebSocket('ws://your-server:8095/sendspin');
const player = new SendspinPlayer({
  clientName: 'My Player',
  webSocket: ws,
});
await player.connect();
```

### Reconnect behavior

Built-in auto-reconnect uses exponential backoff (1s → 15s, unlimited
attempts). Override the bounds, cap the retry count, or hook callbacks to
drive UI and fatal-error paths via `reconnect`.

```typescript
const player = new SendspinPlayer({
  baseUrl: 'http://your-server:8095',
  reconnect: {
    baseDelayMs: 1000,
    maxDelayMs: 15000,
    maxAttempts: 7,
    onReconnecting: (attempt) => console.log(`Reconnecting (attempt ${attempt})`),
    onReconnected: () => console.log('Reconnected'),
    onExhausted: () => console.log('Giving up'),
  },
});
```

Reconnection only applies to connections opened via `baseUrl`; adopted
sockets (`webSocket`) never auto-reconnect.

### Tuning correction thresholds

Override the per-mode thresholds that control when/how the scheduler corrects
drift. Unspecified fields keep their defaults.

```typescript
const player = new SendspinPlayer({
  baseUrl: 'http://your-server:8095',
  correctionMode: 'sync',
  correctionThresholds: {
    sync: {
      resyncAboveMs: 400,   // tolerate more drift before hard resync
      deadbandBelowMs: 2,   // ignore errors under 2ms
    },
  },
});
```

### Buffer timing

Report the startup lead time and ongoing jitter buffer the player needs to the
server via `client/state`. Lower values mean lower latency at the risk of
underruns. Defaults are `requiredLeadTimeMs: 250` and `minBufferMs: 250`.

```typescript
const player = new SendspinPlayer({
  baseUrl: 'http://your-server:8095',
  requiredLeadTimeMs: 250,  // startup warmup (codec init, decode, DAC)
  minBufferMs: 250,         // ongoing buffer to absorb network jitter
});
```

Both can be updated at runtime, e.g. after measuring real lead time post-warmup
or on a link-type change. Debounce updates so transient fluctuations don't churn
server-side timing.

```typescript
player.setRequiredLeadTimeMs(300);
player.setMinBufferMs(1500);
```

### Encryption and pairing

Every connection is encrypted (Noise KKpsk2). By default the SDK connects
with an unpaired (Sentinel-PSK) identity; pair with a server to upgrade to a
trusted, per-server long-term PSK.

```typescript
const player = new SendspinPlayer({
  baseUrl: 'http://your-server:8095',
  suite: 'chacha',            // "chacha" (default) or "aesgcm"
  unpairedAccess: true,       // admit unpaired playback; default true (see note below)
  longTermPsks: [
    { psk: 'base64url-psk', serverId: 'optional-server-id' },
  ],
  onPairing: (event, detail) => {
    // event: "started" | "finalized" | "aborted"
    console.log('Pairing:', event, detail);
  },
  // Dynamic PIN pairing: show the derived PIN to the operator (null = hide).
  onPairingPin: (pin) => showPinDialog(pin),
  minPinLength: 6,            // shortest dynamic PIN this client accepts (4-12)
  // Static PIN pairing: this device's fixed 8-digit PIN.
  staticPin: '31415926',
});

await player.connect();
```

Unpaired playback authenticates with the well-known Sentinel PSK, so it is
exposed to an active man-in-the-middle. While it's on by default, you can set `unpairedAccess: false` to require pairing before any playback.

The SDK supports all three pairing methods from the spec:

- **Pairing PSK** (always available): transfer the client-bound pairing token.
- **Dynamic PIN** (enabled by `onPairingPin`): the server starts pairing, the
  SDK derives a one-time PIN and passes it to `onPairingPin` for display; the
  operator enters it into the server.
- **Static PIN** (enabled by `staticPin`): the operator enters this device's
  fixed 8-digit PIN into the server, then makes a local gesture that calls
  `player.openPairingWindow()` (window lasts ~5 minutes, one attempt).

```typescript
console.log('Client ID:', player.clientId);              // 43-char base64url pubkey
console.log('Pairing token:', player.pairingToken);      // spec version 0, or null without storage

// Rotate the Pairing PSK (e.g. if it may have leaked)
const newPsk = player.rotatePairingPsk();

player.openPairingWindow();                      // static PIN: operator gesture
player.cancelPairing();                          // abort an in-progress attempt
player.isPairingLockedOut('dynamic_pin');        // terminal lockout after 10 failures
player.clearPairingLockout('dynamic_pin');       // local operator action that exits lockout
```

`player.pairingToken` is the version 0 token defined by the current specification. Music Assistant installations using aiosendspin 7.0.0 do not accept the current token format; use PIN pairing until the backend supports version 0.
Identity and pairing require `storage` (defaults to `localStorage`); without
it, `clientId` is still generated per session but `pairingPsk`,
`pairingToken`, and `rotatePairingPsk()` return `null`.

Apps that key their own state on the client id can read it before a player
exists. A player built afterwards on the same storage adopts this identity.

```typescript
import { loadSendspinClientIdentity } from '@sendspin/sendspin-js';

const { clientId, pairingPsk, pairingToken } = loadSendspinClientIdentity();
```

### Core + scheduler as separate layers

Apps that need the decoded PCM stream (e.g. visualizers) can use
`SendspinCore` on its own and skip the playback layer. `SendspinCore` emits
`DecodedAudioChunk` events; `AudioScheduler` is the Web Audio consumer that
`SendspinPlayer` wires for you.

```typescript
import { SendspinCore } from '@sendspin/sendspin-js';

const core = new SendspinCore({
  baseUrl: 'http://your-server:8095',
});

core.onAudioData = (chunk) => {
  // chunk.samples: Float32Array per channel
  // chunk.sampleRate, chunk.serverTimeUs, chunk.generation
};

await core.connect();
```

## Local development

```
yarn dev-server
```

Then browse to http://localhost:6001

## Testing

The E2E tests run directly against
[aiosendspin](https://github.com/Sendspin/aiosendspin) at immutable commit
`9212f920e8fbaf9ad357b43835bd32cc386e73b8`. This upstream commit adds the
current version 0 Pairing Token format. Bootstrap the `.venv` once:

```
./scripts/setup.sh
```

Then:

```
yarn test         # unit + E2E
yarn test:watch   # watch mode
```

To run a single suite, pass the path: `npx vitest run tests/unit` or
`npx vitest run tests/e2e`.
