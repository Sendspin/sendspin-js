# Sendspin E2E Tests

End-to-end tests for the Sendspin audio streaming player that verify correct synchronization and playback behavior.

## Test Philosophy

These tests are designed to:

1. **Only exercise the public API** (`SendspinPlayer` from `index.ts`)
2. **Catch real audio problems** - synchronization bugs, stuttering, desynchronization, dropped chunks
3. **Be implementation-agnostic** - tests focus on observable behavior, not internal implementation
4. **Use synthetic audio data** - real PCM audio chunks generated for testing

## What These Tests Verify

### ✅ Things these tests WILL catch:

- **Scheduling errors** - chunks scheduled at wrong times relative to synchronized clock
- **Out-of-order playback** - chunks arriving out-of-order but not sorted correctly
- **Dropped chunks** - late-arriving chunks that should be dropped but aren't
- **Resync failures** - large drift errors that should trigger resynchronization
- **Buffer management** - seek operations that should clear buffers
- **Time synchronization** - NTP-style clock sync establishment
- **Volume/mute commands** - server and client volume control

### ⚠️ Things these tests CANNOT catch:

- **Actual audio quality issues** - clicks, pops, distortion (requires human listening)
- **Browser-specific codec bugs** - real FLAC/Opus decoder behavior varies by browser
- **Timing precision issues** - mocked AudioContext doesn't test real Web Audio scheduling
- **Real network conditions** - jitter, packet loss, variable latency

## Test Architecture

### Mock Server (`mock-server.ts`)

Implements the Sendspin protocol:
- Responds to `client/hello` with `server/hello`
- Handles `client/time` with NTP-style `server/time` responses
- Can send `stream/start`, `stream/end`, `stream/clear` messages
- Can send binary audio chunks with proper protocol framing
- Simulates configurable clock offset and network latency

### Audio Generator (`audio-generator.ts`)

Generates synthetic PCM audio:
- Creates real PCM audio data (sine waves)
- Supports different sample rates, bit depths, channels
- Generates contiguous chunk sequences with known timestamps
- Useful for testing chunk ordering and timing

### Test Suite (`player.test.ts`)

**Connection Tests:**
- WebSocket connection and handshake
- Protocol message exchange

**Time Synchronization Tests:**
- Establishes clock sync with mock server
- Verifies offset calculation

**Audio Streaming Tests:**
- Chunks scheduled at correct synchronized times
- Out-of-order chunks sorted and played correctly
- Late chunks dropped appropriately
- Large drift triggers resynchronization
- Seek operations clear buffers correctly
- Stream end stops playback

**Volume Control Tests:**
- Server volume/mute commands
- Client-initiated volume changes

**Sync Delay Tests:**
- Runtime sync delay adjustment

## Running the Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# UI mode
npm run test:ui
```

## Test Timing

Tests use **real time** (not mocked), because:
- Time synchronization requires actual setTimeout/setInterval behavior
- The Kalman filter needs real time progression
- Audio scheduling depends on AudioContext.currentTime advancement

As a result, tests that wait for time sync take ~5 seconds each (the TIME_SYNC_INTERVAL).

## Future Improvements

Possible enhancements:
1. **Performance benchmarks** - measure scheduling accuracy, drift handling
2. **Stress testing** - high chunk rate, many out-of-order arrivals
3. **Edge cases** - clock jumps, network reconnection, format changes
4. **Browser compatibility** - run tests across Chrome, Firefox, Safari
5. **Visual test reporter** - show timeline of chunk scheduling

## Interpreting Test Failures

If a test fails, it indicates a real problem:

- **"expected 0 to be 3"** (no sources scheduled) → chunks not being scheduled, likely time sync or buffer processing issue
- **"expected false to be true" (sync)** → time synchronization not establishing correctly
- **Timing assertions fail** → scheduling math is wrong, will cause stuttering or gaps
- **Order assertions fail** → chunks playing in wrong order, will cause audio corruption
- **Resync count assertions** → drift handling not working, will cause desynchronization over time

These are the exact bugs that would cause audio problems in production!
