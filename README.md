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

## Local development

```
yarn dev-server
```

Then browse to http://localhost:6001
