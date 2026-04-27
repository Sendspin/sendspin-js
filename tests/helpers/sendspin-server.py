"""
Sendspin test server powered by aiosendspin.

Provides a real protocol-compliant Sendspin server for E2E testing.
Controlled via a line-based protocol on stdin/stdout so the Node.js
test runner can orchestrate the server.

Protocol:
  → (server prints on start)   READY <port>
  ← WAIT_CLIENT                Wait for a client to connect
  → CLIENT_CONNECTED <id>      Client connected
  ← STREAM_START               Start PCM stream (48kHz/16-bit/stereo)
  → OK                         Acknowledgement
  ← SEND_AUDIO <ms>            Send <ms> of sine-wave PCM audio
  → OK                         Done sending
  ← STREAM_CLEAR               Send stream/clear (seek)
  → OK
  ← STREAM_END                 Send stream/end
  → OK
  ← VOLUME <0-100>             Send volume command to player
  → OK
  ← MUTE <true|false>          Send mute command to player
  → OK
  ← SET_DELAY <ms>             Send set_static_delay command
  → OK
  ← SHUTDOWN                   Graceful shutdown
  → BYE
"""

import asyncio
import math
import struct
import sys
from typing import Any

from aiosendspin.server import (
    AudioFormat,
    ClientAddedEvent,
    ClientUpdatedEvent,
    SendspinEvent,
    SendspinServer,
)


def generate_sine_pcm(
    duration_ms: int,
    frequency: float = 440.0,
    sample_rate: int = 48000,
    channels: int = 2,
) -> bytes:
    """Generate interleaved 16-bit PCM sine wave."""
    num_samples = int(sample_rate * duration_ms / 1000)
    data = bytearray(num_samples * channels * 2)  # 2 bytes per sample (16-bit)
    for i in range(num_samples):
        t = i / sample_rate
        value = int(math.sin(2 * math.pi * frequency * t) * 16000)
        value = max(-32768, min(32767, value))
        for ch in range(channels):
            offset = (i * channels + ch) * 2
            struct.pack_into("<h", data, offset, value)
    return bytes(data)


class TestServer:
    def __init__(self) -> None:
        self.server: SendspinServer | None = None
        self._client_queue: asyncio.Queue[str] = asyncio.Queue()
        self.active_client_id: str | None = None
        self.push_stream: Any = None
        self.audio_format = AudioFormat(
            sample_rate=48000,
            bit_depth=16,
            channels=2,
            sample_type="int",
        )

    def _on_event(self, server: SendspinServer, event: SendspinEvent) -> None:
        # Fire on both new client and reconnection of existing client
        if isinstance(event, (ClientAddedEvent, ClientUpdatedEvent)):
            client_id = event.client_id
            client = server.get_client(client_id)
            if client is not None and client.is_connected:
                self._client_queue.put_nowait(client_id)

    async def start(self) -> int:
        loop = asyncio.get_event_loop()
        self.server = SendspinServer(
            loop=loop,
            server_id="test-server",
            server_name="E2E Test Server",
        )
        self.server.add_event_listener(self._on_event)

        # Use port 0 for random available port
        await self.server.start_server(
            port=0,
            host="127.0.0.1",
            advertise_addresses=["127.0.0.1"],
            discover_clients=False,
        )

        # Extract the port from the running server
        port = self.server._tcp_site._server.sockets[0].getsockname()[1]
        return port

    async def wait_client(self) -> str:
        """Wait for the next client connection. Uses a queue so events aren't lost."""
        client_id = await self._client_queue.get()
        self.active_client_id = client_id
        return client_id

    async def stream_start(self) -> None:
        assert self.server is not None
        assert self.active_client_id is not None

        client = self.server.get_client(self.active_client_id)
        assert client is not None, f"Client {self.active_client_id} not found"

        group = client.group
        self.push_stream = group.start_stream()

        # aiosendspin initializes the resampler pipeline on the first commit
        # and only sends stream/start + audio on the second commit.
        # Send two initial chunks to trigger the full pipeline.
        for _ in range(2):
            pcm = generate_sine_pcm(20, sample_rate=48000, channels=2)
            self.push_stream.prepare_audio(pcm, self.audio_format)
            await self.push_stream.commit_audio()

    async def send_audio(self, duration_ms: int) -> None:
        assert self.push_stream is not None

        pcm = generate_sine_pcm(duration_ms, sample_rate=48000, channels=2)
        self.push_stream.prepare_audio(pcm, self.audio_format)
        await self.push_stream.commit_audio()

    async def stream_clear(self) -> None:
        assert self.server is not None
        assert self.active_client_id is not None

        client = self.server.get_client(self.active_client_id)
        assert client is not None

        group = client.group
        # Stop and restart the stream to simulate a seek/clear
        group.stop_stream()
        self.push_stream = group.start_stream()

    async def stream_end(self) -> None:
        assert self.server is not None
        assert self.active_client_id is not None

        client = self.server.get_client(self.active_client_id)
        assert client is not None

        await client.group.stop()
        self.push_stream = None

    def _get_player_role(self) -> Any:
        assert self.server is not None
        assert self.active_client_id is not None

        client = self.server.get_client(self.active_client_id)
        assert client is not None

        role = client.role("player@v1")
        assert role is not None, "Client has no player@v1 role"
        return role

    def set_volume(self, volume: int) -> None:
        self._get_player_role().set_volume(volume)

    def set_mute(self, muted: bool) -> None:
        self._get_player_role().set_mute(muted)

    def set_delay(self, delay_ms: int) -> None:
        self._get_player_role().set_static_delay(delay_ms)

    async def shutdown(self) -> None:
        if self.server:
            await self.server.close()
            self.server = None


async def main() -> None:
    ts = TestServer()
    port = await ts.start()

    # Signal readiness
    print(f"READY {port}", flush=True)

    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_event_loop().connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        try:
            line = await reader.readline()
        except Exception:
            break

        if not line:
            break

        cmd = line.decode().strip()
        if not cmd:
            continue

        try:
            if cmd == "WAIT_CLIENT":
                client_id = await asyncio.wait_for(ts.wait_client(), timeout=10)
                print(f"CLIENT_CONNECTED {client_id}", flush=True)

            elif cmd == "STREAM_START":
                await ts.stream_start()
                print("OK", flush=True)

            elif cmd.startswith("SEND_AUDIO "):
                duration_ms = int(cmd.split(" ", 1)[1])
                await ts.send_audio(duration_ms)
                print("OK", flush=True)

            elif cmd == "STREAM_CLEAR":
                await ts.stream_clear()
                print("OK", flush=True)

            elif cmd == "STREAM_END":
                await ts.stream_end()
                print("OK", flush=True)

            elif cmd.startswith("VOLUME "):
                volume = int(cmd.split(" ", 1)[1])
                ts.set_volume(volume)
                print("OK", flush=True)

            elif cmd.startswith("MUTE "):
                muted = cmd.split(" ", 1)[1].lower() == "true"
                ts.set_mute(muted)
                print("OK", flush=True)

            elif cmd.startswith("SET_DELAY "):
                delay = int(cmd.split(" ", 1)[1])
                ts.set_delay(delay)
                print("OK", flush=True)

            elif cmd == "SHUTDOWN":
                await ts.shutdown()
                print("BYE", flush=True)
                break

            else:
                print(f"ERROR unknown command: {cmd}", flush=True)

        except Exception as e:
            print(f"ERROR {e}", flush=True)

    # Ensure cleanup
    await ts.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
