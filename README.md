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
  productName: 'My App',
  // Optional: "sync" (default), "quality" (no pitch shifts; not recommended for bad networks),
  // or "quality-local" (best for unsynced playback, makes the player non-compliant with the Sendspin spec)
  correctionMode: 'sync',
  onStateChange: (state) => {
    // Local player state
    console.log('Playing:', state.isPlaying);
    console.log('Volume:', state.volume, 'Muted:', state.muted);

    // Server state (metadata, controller info)
    if (state.serverState?.metadata) {
      const meta = state.serverState.metadata;
      console.log('Track:', meta.title, '-', meta.artist);
      console.log('Album:', meta.album, 'by', meta.album_artist, '#', meta.track);
    }
    if (state.serverState?.controller) {
      const ctrl = state.serverState.controller;
      console.log('Commands:', ctrl.supported_commands);
      console.log('Repeat:', ctrl.repeat, 'Shuffle:', ctrl.shuffle);
    }

    // Group state (playback state, group info)
    if (state.groupState) {
      console.log('Group:', state.groupState.group_name);
      console.log('Playback:', state.groupState.playback_state);
    }
  }
});

const connectButton = document.querySelector<HTMLButtonElement>('#connect')!;
connectButton.addEventListener('click', async () => {
  // Keep this as the first awaited work in the click/tap handler.
  await player.unlock();
  await player.connect();
});

// Local volume control (affects this player only)
player.setVolume(80);
player.setMuted(false);

// Send commands to server (controls the source). Each must be listed in
// the latest controller state's supported_commands, otherwise this throws.
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
player.sendCommand('seek', { position_ms: 90_000 });  // Clamped to 0 through seek_max_ms
player.sendCommand('seek_relative', { offset_ms: -10_000 });

// Disconnect with reason (optional)
player.disconnect('user_request');

// Release the audio output when you no longer need the player
player.destroy();
```

Call `unlock()` directly from a click or tap handler, before any other awaited
work, so the browser can initialize or resume audio during the user gesture.

Keep one player for repeated stops and starts, and call `destroy()` only when
you drop it. A player dropped after `disconnect()` keeps its audio output open.

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
await player.unlock();
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
    { psk: 'base64url-psk', serverId: 'base64url-server-id' },
  ],
  onPairing: (event, detail) => {
    // event: "pending" | "started" | "finalized" | "aborted"
    // "pending" means the attempt is waiting for openPairingWindow() or releasePairingHold().
    console.log('Pairing:', event, detail);
  },
  // Dynamic pairing: show the derived code to the operator (null = hide).
  // languages carries the operator's spoken-code preference, when the server sends one.
  onPairingCode: (code, languages) => showCodeDialog(code, languages),
  // Advertise "speaker" if the app can speak the code. `languages` says which language to use.
  pairingCodeOutChannels: ['display'],
  // Or, for devices with no display or speaker: a fixed 8-digit code,
  // random and unique per device. Avoid setting both code methods.
  // staticPairingCode: deviceStaticCode,
  // Where the operator finds each secret, if you know. Any combination of
  // device | leaflet | operator. Omitted from client/hello when unset.
  // staticPairingCodeLocations: ['device', 'leaflet'],
});

await player.connect();
```

Unpaired playback authenticates with the well-known Sentinel PSK, so it is
exposed to an active man-in-the-middle. While it's on by default, you can set `unpairedAccess: false` to require pairing before any playback.

The SDK supports all three pairing methods from the spec:

- **Pairing PSK** (always available): transfer the client-bound pairing token.
- **Dynamic pairing code** (enabled by `onPairingCode`): the server starts
  pairing, the SDK derives a one-time code and passes it to `onPairingCode` for
  display, and the operator enters it into the server. After a wrong entry the
  SDK asks the server for another round and passes the same code again.
- **Static pairing code** (enabled by `staticPairingCode`): the operator enters
  this device's fixed 8-digit code into the server, then makes a local gesture
  that calls `player.openPairingWindow()`. The window lasts ~5 minutes and
  closes early after a completed pairing, five wrong codes, a drop of the
  connection that used it, or `cancelPairing()`.

Some attempts are **held back**: the SDK withholds `client/pair-init`,
signalling `client/pair-pending` meanwhile and firing `onPairing("pending")`.
A static pairing code attempt waits for an open pairing window. After 20
dynamic pairing code rounds without a correct code, dynamic pairing code
attempts wait for `releasePairingHold()`, which also resets the count. Call it
only on a deliberate action on the device.

```typescript
console.log('Client ID:', player.clientId);              // 43-char base64url pubkey
console.log('Pairing token:', player.pairingToken);      // spec version 0

// Rotate the Pairing PSK (e.g. if the token may have leaked)
const newToken = player.rotatePairingPsk();

player.openPairingWindow();                      // operator gesture for a static code attempt
player.releasePairingHold();                     // operator action after the round limit
player.cancelPairing();                          // close the window and abort any attempt
player.isRoundLimitReached();                    // held back after 20 rounds without a correct code
```

Pairing requires a server speaking the current specification. A non-compliant
server announces the pairing method in a field this SDK no longer reads, so the
activation arrives without one and the client closes the connection as a
protocol error, logging the reason to the console.

`player.pairingToken` is the version 0 token defined by the current specification.
Identity and pairing persist in `storage` (defaults to `localStorage`). Without
it, `clientId`, the Pairing PSK and any paired server are kept in memory only,
so a reload needs a fresh pairing.

Apps that key their own state on the client id can read it before a player
exists. A player built afterwards on the same storage adopts this identity.

```typescript
import { loadSendspinClientIdentity } from '@sendspin/sendspin-js';

const { clientId, pairingToken } = loadSendspinClientIdentity();
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
[aiosendspin](https://github.com/Sendspin/aiosendspin). Bootstrap the `.venv`
once:

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
