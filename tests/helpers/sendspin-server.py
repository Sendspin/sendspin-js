"""Direct aiosendspin E2E server controlled through JSON lines on stdin/stdout."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import struct
import sys
from contextlib import suppress
from pathlib import Path
from typing import Any

from aiohttp import web
from aiohttp.test_utils import TestServer as AiohttpTestServer
from aiosendspin.models.core import ClientStateMessage
from aiosendspin.models.types import PairingCodeFormat, PairMethod
from aiosendspin.noise.keys import Identity, b64url_decode
from aiosendspin.noise.pairing import PairingAbortError, PairingAttempt
from aiosendspin.noise.pairing_token import decode_psk_token
from aiosendspin.noise.trust_store import FileServerPairingStore
from aiosendspin.server import (
    AudioFormat,
    ClientConnectedEvent,
    SendspinEvent,
    SendspinServer,
)
from aiosendspin.server.connection import SendspinConnection


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
        self.code_task: asyncio.Task[dict[str, Any]] | None = None
        self.code_future: asyncio.Future[str] | None = None
        self.code_requested: asyncio.Event | None = None
        self.raw_client_state: dict[str, Any] | None = None
        self.raw_client_state_accepted = False

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
        )
        self._install_client_state_capture()
        self.server.add_event_listener(self._on_event)
        app = web.Application()
        app.router.add_get(SendspinServer.API_PATH, self.server.on_client_connect)
        self.http_server = AiohttpTestServer(app, host="127.0.0.1")
        await self.http_server.start_server()
        assert self.http_server.port is not None
        return self.http_server.port

    def _install_client_state_capture(self) -> None:
        """Capture the client/state payload as sent, before upstream normalizes it."""
        original_deserialize = SendspinConnection._deserialize_client_message
        original_handle_message = SendspinConnection._handle_message

        def deserialize(cls: Any, raw_message: str, active_families: Any = None) -> Any:
            message = original_deserialize(raw_message, active_families)
            if isinstance(message, ClientStateMessage):
                self.raw_client_state = json.loads(raw_message)["payload"]
                self.raw_client_state_accepted = False
            return message

        async def handle(
            connection: SendspinConnection,
            message: Any,
            timestamp_us: int,
        ) -> None:
            await original_handle_message(connection, message, timestamp_us)
            if isinstance(message, ClientStateMessage):
                self.raw_client_state_accepted = True

        SendspinConnection._deserialize_client_message = classmethod(deserialize)
        SendspinConnection._handle_message = handle

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
            "active_roles": [role.role_id for role in client.active_roles] if client else [],
            "supported_pair_methods": self._pair_methods(info),
            "has_pairing_record": record is not None,
        }

    @staticmethod
    def _pair_methods(info: Any) -> dict[str, Any]:
        methods = info.supported_pair_methods if info is not None else None
        if methods is None:
            return {}
        return {
            method.value: json.loads(descriptor.to_json())
            for method in PairMethod
            if (descriptor := getattr(methods, method.value)) is not None
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
                raw_player = (
                    self.raw_client_state.get("player")
                    if self.raw_client_state is not None
                    else None
                )
                if (
                    client is not None
                    and client.is_connected
                    and role is not None
                    and role.get_player_volume() == expected_volume
                    and self.raw_client_state_accepted
                    and isinstance(raw_player, dict)
                    and raw_player.get("volume") == expected_volume
                ):
                    return {
                        "raw_payload": self.raw_client_state,
                        "semantic_state": {
                            "available": client.available,
                            "player": {
                                "volume": role.get_player_volume(),
                                "muted": role.get_player_muted(),
                                "output_delay_ms": role.get_output_delay_ms(),
                                "required_lead_time_ms": role.required_lead_time_ms,
                                "min_buffer_ms": role.min_buffer_ms,
                                "supported_commands": [
                                    command.value for command in role.state_supported_commands
                                ],
                            },
                        },
                    }
                await asyncio.sleep(0.01)

    async def pair_with_token(self, token_value: str) -> dict[str, Any]:
        client_id = self._connected_client_id()
        try:
            token = decode_psk_token(token_value)
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
                    client_id=token.client_id,
                ),
            )
        )

    async def begin_code_pairing(self, method_name: str) -> dict[str, Any]:
        if self.code_task is not None and not self.code_task.done():
            raise RuntimeError("a pairing code attempt is already running")
        method = PairMethod(method_name)
        if method not in (PairMethod.DYNAMIC_PAIRING_CODE, PairMethod.STATIC_PAIRING_CODE):
            raise ValueError("code pairing requires dynamic_pairing_code or static_pairing_code")
        self.code_future = None
        self.code_requested = asyncio.Event()

        # Called once per round, so each round waits for its own submitted code.
        async def provide_code() -> str:
            assert self.code_requested is not None
            self.code_future = asyncio.get_running_loop().create_future()
            self.code_requested.set()
            return await self.code_future

        assert self.server is not None
        client_id = self._connected_client_id()
        self.code_task = asyncio.create_task(
            self._run_pairing(
                self.server.initiate_pairing(
                    client_id,
                    PairingAttempt(
                        method=method,
                        pairing_code_provider=provide_code,
                        pairing_format=PairingCodeFormat.DIGITS
                        if method is PairMethod.DYNAMIC_PAIRING_CODE
                        else None,
                    ),
                )
            )
        )
        return {"status": "started", "method": method.value}

    async def wait_for_code_request(self, timeout_ms: int) -> dict[str, Any]:
        if self.code_task is None or self.code_requested is None:
            raise RuntimeError("no pairing code attempt is running")
        if self.code_task.done():
            return await self._finish_code_attempt()
        waiter = asyncio.create_task(self.code_requested.wait())
        try:
            done, _ = await asyncio.wait(
                {waiter, self.code_task},
                timeout=timeout_ms / 1000,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if self.code_task in done:
                return await self._finish_code_attempt()
            if waiter in done:
                return {"status": "code_requested"}
            return {"status": "timeout"}
        finally:
            waiter.cancel()
            with suppress(asyncio.CancelledError):
                await waiter

    async def submit_code(self, code: str) -> dict[str, Any]:
        if self.code_task is None or self.code_future is None or self.code_requested is None:
            raise RuntimeError("no pairing code attempt is running")
        if not self.code_future.done():
            self.code_future.set_result(code)
        self.code_requested.clear()
        return await self.wait_for_code_request(30_000)

    async def _finish_code_attempt(self) -> dict[str, Any]:
        assert self.code_task is not None
        try:
            return await self.code_task
        finally:
            self.code_task = None
            self.code_future = None
            self.code_requested = None

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
        self._player_role().set_output_delay(delay_ms)

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
        if self.code_task is not None and not self.code_task.done():
            if self.server is not None and self.active_client_id is not None:
                with suppress(Exception):
                    await self.server.end_pairing(self.active_client_id)
            self.code_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await self.code_task
        self.code_task = None
        self.code_future = None
        self.code_requested = None
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
    if command == "begin_code":
        return await server.begin_code_pairing(str(args["method"]))
    if command == "wait_code":
        return await server.wait_for_code_request(int(args.get("timeout_ms", 10000)))
    if command == "submit_code":
        return await server.submit_code(str(args["code"]))
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


class JsonLogHandler(logging.Handler):
    """Write each log record to stderr as one JSON line for the test harness."""

    def emit(self, record: logging.LogRecord) -> None:
        line = json.dumps(
            {"log": {"level": record.levelname, "name": record.name, "message": self.format(record)}}
        )
        print(line, file=sys.stderr, flush=True)


async def main() -> None:
    aiosendspin_logger = logging.getLogger("aiosendspin")
    aiosendspin_logger.setLevel(logging.WARNING)
    aiosendspin_logger.addHandler(JsonLogHandler())
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
