"""Direct aiosendspin E2E server controlled through JSON lines on stdin/stdout."""

from __future__ import annotations

import asyncio
import json
import math
import os
import struct
import sys
from contextlib import suppress
from pathlib import Path
from typing import Any

from aiohttp import web
from aiohttp.test_utils import TestServer as AiohttpTestServer
from aiosendspin.models.types import PairMethod
from aiosendspin.noise.keys import Identity, b64url_decode
from aiosendspin.noise.pairing import PairingAbortError, PairingAttempt
from aiosendspin.noise.pairing_token import decode_token
from aiosendspin.noise.trust_store import FileServerPairingStore
from aiosendspin.server import (
    AudioFormat,
    ClientConnectedEvent,
    SendspinEvent,
    SendspinServer,
)


def generate_sine_pcm(
    duration_ms: int,
    frequency: float = 440.0,
    sample_rate: int = 48000,
    channels: int = 2,
) -> bytes:
    """Generate interleaved 16-bit PCM sine-wave audio."""
    num_samples = int(sample_rate * duration_ms / 1000)
    data = bytearray(num_samples * channels * 2)
    for index in range(num_samples):
        value = int(math.sin(2 * math.pi * frequency * index / sample_rate) * 16000)
        value = max(-32768, min(32767, value))
        for channel in range(channels):
            struct.pack_into("<h", data, (index * channels + channel) * 2, value)
    return bytes(data)


class HarnessServer:
    """Hide aiosendspin server, persistence, and pairing orchestration."""

    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir
        self.server: SendspinServer | None = None
        self.http_server: AiohttpTestServer | None = None
        self.pairing_store: FileServerPairingStore | None = None
        self.client_queue: asyncio.Queue[str] = asyncio.Queue()
        self.active_client_id: str | None = None
        self.push_stream: Any = None
        self.audio_format = AudioFormat(
            sample_rate=48000,
            bit_depth=16,
            channels=2,
            sample_type="int",
        )
        self.pin_task: asyncio.Task[dict[str, Any]] | None = None
        self.pin_future: asyncio.Future[str] | None = None
        self.pin_requested: asyncio.Event | None = None

    async def start(self) -> int:
        """Start a Noise-only server on an ephemeral loopback port."""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        identity = self._load_identity()
        self.pairing_store = await FileServerPairingStore.open(
            self.state_dir / "pairing-store.json"
        )
        self.server = SendspinServer(
            loop=asyncio.get_running_loop(),
            identity=identity,
            server_name="Sendspin JS E2E",
            pairing_store=self.pairing_store,
            allow_unencrypted=False,
            allow_noncompliant_clients=False,
            min_pin_length=6,
        )
        self.server.add_event_listener(self._on_event)
        app = web.Application()
        app.router.add_get(SendspinServer.API_PATH, self.server.on_client_connect)
        self.http_server = AiohttpTestServer(app, host="127.0.0.1")
        await self.http_server.start_server()
        assert self.http_server.port is not None
        return self.http_server.port

    def _load_identity(self) -> Identity:
        key_path = self.state_dir / "identity.key"
        try:
            return Identity.from_private_bytes(b64url_decode(key_path.read_text().strip()))
        except FileNotFoundError:
            identity = Identity.generate()
            fd = os.open(key_path, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as file:
                file.write(identity.private_b64u)
            return identity

    def _on_event(self, server: SendspinServer, event: SendspinEvent) -> None:
        if isinstance(event, ClientConnectedEvent):
            self.active_client_id = event.client_id
            self.client_queue.put_nowait(event.client_id)

    async def wait_client(self, timeout_ms: int) -> dict[str, Any]:
        """Wait for a currently connected client and return its public status."""
        async with asyncio.timeout(timeout_ms / 1000):
            while True:
                client_id = await self.client_queue.get()
                while True:
                    client = self.server.get_client(client_id) if self.server else None
                    if client is not None and client.is_connected:
                        self.active_client_id = client_id
                        return await self.status(client_id)
                    if client is None or client.connection is None:
                        break
                    await asyncio.sleep(0.01)

    async def status(self, client_id: str | None = None) -> dict[str, Any]:
        """Return public connection, trust, role, and persistence state."""
        selected_id = client_id or self.active_client_id
        client = self.server.get_client(selected_id) if self.server and selected_id else None
        security = client.connection_security if client is not None else None
        info = client.info_or_none if client is not None else None
        record = (
            await self.pairing_store.record_by_client_id(selected_id)
            if self.pairing_store is not None and selected_id is not None
            else None
        )
        return {
            "client_id": selected_id,
            "connected": client is not None and client.is_connected,
            "psk_category": security.psk_category.value if security else None,
            "trust_level": security.trust_level.value if security else None,
            "active_roles": [role.role_id for role in client.active_roles] if client else [],
            "supported_pair_methods": [
                descriptor.method.value for descriptor in (info.supported_pair_methods or [])
            ]
            if info
            else [],
            "has_pairing_record": record is not None,
        }

    async def trust_unpaired(self, client_id: str) -> dict[str, Any]:
        assert self.server is not None
        await self.server.trust_unpaired(client_id)
        return await self.status(client_id)

    async def wait_client_state(
        self,
        client_id: str,
        expected_volume: int,
        timeout_ms: int,
    ) -> dict[str, Any]:
        """Wait until public upstream state reflects the expected player update."""
        async with asyncio.timeout(timeout_ms / 1000):
            while True:
                client = self.server.get_client(client_id) if self.server else None
                role = client.role("player@v1") if client is not None else None
                if (
                    client is not None
                    and client.is_connected
                    and role is not None
                    and role.get_player_volume() == expected_volume
                ):
                    return {
                        "available": client.available,
                        "player": {
                            "volume": role.get_player_volume(),
                            "muted": role.get_player_muted(),
                            "static_delay_ms": role.get_static_delay_ms(),
                            "required_lead_time_ms": role.required_lead_time_ms,
                            "min_buffer_ms": role.min_buffer_ms,
                            "supported_commands": [
                                command.value for command in role.state_supported_commands
                            ],
                        },
                    }
                await asyncio.sleep(0.01)

    async def pair_with_token(self, token_value: str) -> dict[str, Any]:
        client_id = self._connected_client_id()
        try:
            token = decode_token(token_value)
        except ValueError:
            return await self._pairing_result("rejected", "invalid_token")
        if token.client_id != client_id:
            return await self._pairing_result("rejected", "client_id_mismatch")
        assert self.server is not None
        return await self._run_pairing(
            self.server.initiate_pairing(
                client_id,
                PairingAttempt(
                    method=PairMethod.PAIRING_PSK,
                    pairing_psk=token.pairing_psk,
                ),
            )
        )

    async def begin_pin_pairing(self, method_name: str) -> dict[str, Any]:
        if self.pin_task is not None and not self.pin_task.done():
            raise RuntimeError("a PIN pairing attempt is already running")
        method = PairMethod(method_name)
        if method not in (PairMethod.DYNAMIC_PIN, PairMethod.STATIC_PIN):
            raise ValueError("PIN pairing requires dynamic_pin or static_pin")
        self.pin_future = asyncio.get_running_loop().create_future()
        self.pin_requested = asyncio.Event()

        async def provide_pin() -> str:
            assert self.pin_requested is not None
            assert self.pin_future is not None
            self.pin_requested.set()
            return await self.pin_future

        assert self.server is not None
        client_id = self._connected_client_id()
        self.pin_task = asyncio.create_task(
            self._run_pairing(
                self.server.initiate_pairing(
                    client_id,
                    PairingAttempt(method=method, pin_provider=provide_pin),
                )
            )
        )
        return {"status": "started", "method": method.value}

    async def wait_for_pin_request(self, timeout_ms: int) -> dict[str, Any]:
        if self.pin_task is None or self.pin_requested is None:
            raise RuntimeError("no PIN pairing attempt is running")
        if self.pin_task.done():
            return await self._finish_pin_attempt()
        waiter = asyncio.create_task(self.pin_requested.wait())
        try:
            done, _ = await asyncio.wait(
                {waiter, self.pin_task},
                timeout=timeout_ms / 1000,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if self.pin_task in done:
                return await self._finish_pin_attempt()
            if waiter in done:
                return {"status": "pin_requested"}
            return {"status": "timeout"}
        finally:
            waiter.cancel()
            with suppress(asyncio.CancelledError):
                await waiter

    async def submit_pin(self, pin: str) -> dict[str, Any]:
        if self.pin_task is None or self.pin_future is None:
            raise RuntimeError("no PIN pairing attempt is running")
        if not self.pin_future.done():
            self.pin_future.set_result(pin)
        return await self._finish_pin_attempt()

    async def _finish_pin_attempt(self) -> dict[str, Any]:
        assert self.pin_task is not None
        try:
            return await self.pin_task
        finally:
            self.pin_task = None
            self.pin_future = None
            self.pin_requested = None

    async def _run_pairing(self, pairing: Any) -> dict[str, Any]:
        try:
            await pairing
        except PairingAbortError as error:
            return await self._pairing_result("aborted", error.reason.value)
        except Exception as error:
            return await self._pairing_result("error", type(error).__name__)
        return await self._pairing_result("success", None)

    async def _pairing_result(self, status: str, reason: str | None) -> dict[str, Any]:
        await asyncio.sleep(0)
        result = await self.status()
        result.update({"status": status, "reason": reason})
        return result

    def _connected_client_id(self) -> str:
        if not self.active_client_id or not self.server:
            raise RuntimeError("no active client")
        client = self.server.get_client(self.active_client_id)
        if client is None or not client.is_connected:
            raise RuntimeError("no active client")
        return self.active_client_id

    async def stream_start(self) -> None:
        client = self._active_client()
        self.push_stream = client.group.start_stream()
        for _ in range(2):
            pcm = generate_sine_pcm(20)
            self.push_stream.prepare_audio(pcm, self.audio_format)
            await self.push_stream.commit_audio()

    async def send_audio(self, duration_ms: int) -> None:
        if self.push_stream is None:
            raise RuntimeError("no stream is active")
        self.push_stream.prepare_audio(generate_sine_pcm(duration_ms), self.audio_format)
        await self.push_stream.commit_audio()

    async def stream_clear(self) -> None:
        if self.push_stream is None:
            raise RuntimeError("no stream is active")
        self.push_stream.clear()

    async def stream_end(self) -> None:
        await self._active_client().group.stop()
        self.push_stream = None

    def set_volume(self, volume: int) -> None:
        self._player_role().set_volume(volume)

    def set_mute(self, muted: bool) -> None:
        self._player_role().set_mute(muted)

    def set_delay(self, delay_ms: int) -> None:
        self._player_role().set_static_delay(delay_ms)

    def _active_client(self) -> Any:
        if not self.server or not self.active_client_id:
            raise RuntimeError("no active client")
        client = self.server.get_client(self.active_client_id)
        if client is None:
            raise RuntimeError("no active client")
        return client

    def _player_role(self) -> Any:
        role = self._active_client().role("player@v1")
        if role is None:
            raise RuntimeError("client has no active player@v1 role")
        return role

    async def shutdown(self) -> None:
        if self.pin_task is not None and not self.pin_task.done():
            if self.server is not None and self.active_client_id is not None:
                with suppress(Exception):
                    await self.server.end_pairing(self.active_client_id)
            self.pin_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await self.pin_task
        self.pin_task = None
        self.pin_future = None
        self.pin_requested = None
        if self.http_server is not None:
            await self.http_server.close()
            self.http_server = None
        if self.server is not None:
            await self.server.close()
            self.server = None


async def dispatch(server: HarnessServer, command: str, args: dict[str, Any]) -> Any:
    """Run one command without exposing aiosendspin details to the caller."""
    if command == "wait_client":
        return await server.wait_client(int(args.get("timeout_ms", 10000)))
    if command == "status":
        return await server.status(args.get("client_id"))
    if command == "trust_unpaired":
        return await server.trust_unpaired(str(args["client_id"]))
    if command == "wait_client_state":
        return await server.wait_client_state(
            str(args["client_id"]),
            int(args["expected_volume"]),
            int(args.get("timeout_ms", 10000)),
        )
    if command == "pair_token":
        return await server.pair_with_token(str(args["token"]))
    if command == "begin_pin":
        return await server.begin_pin_pairing(str(args["method"]))
    if command == "wait_pin":
        return await server.wait_for_pin_request(int(args.get("timeout_ms", 10000)))
    if command == "submit_pin":
        return await server.submit_pin(str(args["pin"]))
    if command == "stream_start":
        await server.stream_start()
        return None
    if command == "send_audio":
        await server.send_audio(int(args["duration_ms"]))
        return None
    if command == "stream_clear":
        await server.stream_clear()
        return None
    if command == "stream_end":
        await server.stream_end()
        return None
    if command == "volume":
        server.set_volume(int(args["volume"]))
        return None
    if command == "mute":
        server.set_mute(bool(args["muted"]))
        return None
    if command == "set_delay":
        server.set_delay(int(args["delay_ms"]))
        return None
    if command == "shutdown":
        await server.shutdown()
        return "bye"
    raise ValueError(f"unknown command: {command}")


async def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: sendspin-server.py <state-dir>")
    server = HarnessServer(Path(sys.argv[1]).resolve())
    port = await server.start()
    print(json.dumps({"ready": {"port": port}}), flush=True)

    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)

    while line := await reader.readline():
        try:
            request = json.loads(line)
            result = await dispatch(
                server,
                str(request["command"]),
                dict(request.get("args") or {}),
            )
            print(json.dumps({"ok": True, "result": result}), flush=True)
            if request["command"] == "shutdown":
                break
        except Exception as error:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": type(error).__name__,
                    }
                ),
                flush=True,
            )

    await server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
