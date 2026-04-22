# sendspin-js

[![npm](https://img.shields.io/npm/v/@sendspin/sendspin-js.svg)](https://www.npmjs.com/package/@sendspin/sendspin-js)

TypeScript client library implementing the [Sendspin Protocol](https://www.sendspin-audio.com) for clock-synchronized audio streaming.

See the SDK website to see Sendspin JS in action: https://sendspin.github.io/sendspin-js/

[![A project from the Open Home Foundation](https://www.openhomefoundation.org/badges/ohf-project.png)](https://www.openhomefoundation.org/)

## Example

```typescript
import { SendspinPlayer } from '@sendspin/sendspin-js';

const player = new SendspinPlayer({
  playerId: 'my-player-id',
  baseUrl: 'http://your-server:8095',
  clientName: 'My Web Player',
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
  playerId: 'my-player',
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
