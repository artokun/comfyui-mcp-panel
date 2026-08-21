"""#1596 — identity is a protocol probe, not a TCP connect.

Logitech G HUB's lghub_agent sits on 9180. A successful connect_ex used to mean
"an orchestrator owns the bridge", so /status reported running: true and the
panel sat through a 20–45 s handshake with something that is not the agent.

These drive the shipped ``_probe_bridge`` / ``_status_body`` /
``_store_advertised_bridge`` functions against real sockets. Nothing here
inspects source text.

Run from the repo root:

    python -m unittest browser_tests.unit.test_bridge_identity
"""

import base64
import hashlib
import importlib.util
import json
import os
import socket
import threading
import unittest

_REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def _load_init():
    spec = importlib.util.spec_from_file_location(
        "cmcp_panel_init_bridge", os.path.join(_REPO, "__init__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_init()

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _ws_accept(key):
    digest = hashlib.sha1(
        (key + _WS_GUID).encode("ascii"), usedforsecurity=False
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def _server_text_frame(payload):
    body = payload.encode("utf-8")
    if len(body) >= 126:
        raise ValueError("test frame unexpectedly large")
    return bytes((0x81, len(body))) + body


class _TcpListener:
    """Accept connections and stay silent (or speak HTTP that is not WS)."""

    def __init__(self, handler):
        self._handler = handler
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self.port = self._sock.getsockname()[1]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def _run(self):
        self._sock.settimeout(0.2)
        while not self._stop.is_set():
            try:
                conn, _addr = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                self._handler(conn)
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def close(self):
        self._stop.set()
        try:
            self._sock.close()
        except OSError:
            pass
        self._thread.join(timeout=2)


def _silent_handler(conn):
    conn.settimeout(0.5)
    try:
        conn.recv(1024)
    except OSError:
        pass


def _http_200_handler(conn):
    conn.settimeout(0.5)
    try:
        conn.recv(4096)
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
    except OSError:
        pass


def _protocol_handler(reply_type):
    def handle(conn):
        conn.settimeout(2)
        try:
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                buf += chunk
            header, _rest = buf.split(b"\r\n\r\n", 1)
            key = None
            for line in header.decode("utf-8", "replace").split("\r\n"):
                if line.lower().startswith("sec-websocket-key:"):
                    key = line.split(":", 1)[1].strip()
            if not key:
                return
            accept = _ws_accept(key)
            conn.sendall(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    "Sec-WebSocket-Accept: {0}\r\n"
                    "\r\n"
                )
                .format(accept)
                .encode("ascii")
            )
            # Wait for the client's hello frame so we mimic the real bridge.
            conn.recv(4096)
            conn.sendall(
                _server_text_frame(json.dumps({"type": reply_type, "models": []}))
            )
        except OSError:
            pass

    return handle


class ProbeIdentity(unittest.TestCase):
    def test_closed_port_is_not_running_and_not_held(self):
        port = _free_port()
        result = mod._probe_bridge("127.0.0.1", port, timeout=0.4)
        self.assertEqual(result["running"], False)
        self.assertEqual(result["port_held_by_other_process"], False)

    def test_silent_tcp_listener_is_not_an_orchestrator(self):
        server = _TcpListener(_silent_handler).start()
        self.addCleanup(server.close)
        result = mod._probe_bridge("127.0.0.1", server.port, timeout=0.6)
        self.assertEqual(result["running"], False)
        self.assertEqual(result["port_held_by_other_process"], True)

    def test_http_listener_is_not_an_orchestrator(self):
        server = _TcpListener(_http_200_handler).start()
        self.addCleanup(server.close)
        result = mod._probe_bridge("127.0.0.1", server.port, timeout=0.8)
        self.assertEqual(result["running"], False)
        self.assertEqual(result["port_held_by_other_process"], True)

    def test_hello_models_responder_is_running(self):
        server = _TcpListener(_protocol_handler("models")).start()
        self.addCleanup(server.close)
        result = mod._probe_bridge("127.0.0.1", server.port, timeout=1.2)
        self.assertEqual(result["running"], True)
        self.assertEqual(result["port_held_by_other_process"], False)

    def test_session_epoch_frame_also_counts(self):
        server = _TcpListener(_protocol_handler("session_epoch")).start()
        self.addCleanup(server.close)
        result = mod._probe_bridge("127.0.0.1", server.port, timeout=1.2)
        self.assertEqual(result["running"], True)
        self.assertEqual(result["port_held_by_other_process"], False)

    def _isolate_ports(self, default_port, legacy_port=None):
        old_default = mod._BRIDGE_PORT
        old_legacy = mod._LEGACY_BRIDGE_PORT
        old_advertised = mod._ADVERTISED_LOCAL_URL
        self.addCleanup(lambda: setattr(mod, "_BRIDGE_PORT", old_default))
        self.addCleanup(lambda: setattr(mod, "_LEGACY_BRIDGE_PORT", old_legacy))
        self.addCleanup(lambda: setattr(mod, "_ADVERTISED_LOCAL_URL", old_advertised))
        mod._BRIDGE_PORT = default_port
        mod._LEGACY_BRIDGE_PORT = legacy_port if legacy_port is not None else _free_port()
        mod._ADVERTISED_LOCAL_URL = None

    def test_status_body_reports_the_probe_fields(self):
        server = _TcpListener(_silent_handler).start()
        self.addCleanup(server.close)
        self._isolate_ports(server.port)
        body = mod._status_body()
        self.assertEqual(body["running"], False)
        self.assertEqual(body["port_held_by_other_process"], True)
        self.assertEqual(body["port"], server.port)

    def test_status_body_running_true_for_a_protocol_peer(self):
        server = _TcpListener(_protocol_handler("backends")).start()
        self.addCleanup(server.close)
        self._isolate_ports(server.port)
        body = mod._status_body()
        self.assertEqual(body["running"], True)
        self.assertEqual(body["port_held_by_other_process"], False)

    def test_status_legacy_protocol_peer_is_running_when_default_is_silent(self):
        live = _TcpListener(_protocol_handler("models")).start()
        self.addCleanup(live.close)
        self._isolate_ports(_free_port(), live.port)
        body = mod._status_body()
        self.assertEqual(body["running"], True)
        self.assertEqual(body["port_held_by_other_process"], False)
        self.assertEqual(body["port"], live.port)
        self.assertEqual(body["bridge_url"], "ws://127.0.0.1:{}".format(live.port))

    def test_status_probe_ports_include_legacy_9180(self):
        ports = mod._status_probe_ports()
        self.assertIn(mod._BRIDGE_PORT, ports)
        self.assertIn(mod._LEGACY_BRIDGE_PORT, ports)
        self.assertEqual(mod._LEGACY_BRIDGE_PORT, 9180)


class AdvertiseLocalUrl(unittest.TestCase):
    def setUp(self):
        self._old_url = mod._ADVERTISED_BRIDGE_URL
        self._old_local = mod._ADVERTISED_LOCAL_URL
        mod._ADVERTISED_BRIDGE_URL = None
        mod._ADVERTISED_LOCAL_URL = None

    def tearDown(self):
        mod._ADVERTISED_BRIDGE_URL = self._old_url
        mod._ADVERTISED_LOCAL_URL = self._old_local

    def test_accepts_local_url_alongside_the_tunnel(self):
        ok, message, status = mod._store_advertised_bridge(
            {
                "url": "wss://tunnel.example/bridge?token=x",
                "local_url": "ws://127.0.0.1:9180",
            }
        )
        self.assertTrue(ok, message)
        self.assertEqual(status, 200)
        payload = mod._advertised_bridge_payload()
        self.assertEqual(payload["url"], "wss://tunnel.example/bridge?token=x")
        self.assertEqual(payload["local_url"], "ws://127.0.0.1:9180")
        self.assertEqual(mod._status_bridge_url(), "ws://127.0.0.1:9180")

    def test_rejects_a_non_loopback_local_url(self):
        ok, message, status = mod._store_advertised_bridge(
            {"local_url": "ws://evil.example:9199"}
        )
        self.assertFalse(ok)
        self.assertEqual(status, 400)
        self.assertIsNone(mod._ADVERTISED_LOCAL_URL)

    def test_existing_wss_only_payload_still_works(self):
        ok, message, status = mod._store_advertised_bridge(
            {"url": "wss://tunnel.example/bridge"}
        )
        self.assertTrue(ok, message)
        self.assertEqual(status, 200)
        payload = mod._advertised_bridge_payload()
        self.assertEqual(payload["url"], "wss://tunnel.example/bridge")
        self.assertIsNone(payload["local_url"])


class DefaultPort(unittest.TestCase):
    def test_compiled_default_is_9199_unless_env_overrides(self):
        override = os.environ.get("COMFYUI_MCP_BRIDGE_PORT")
        if override:
            self.assertEqual(mod._BRIDGE_PORT, int(override))
        else:
            self.assertEqual(mod._BRIDGE_PORT, 9199)
        self.assertEqual(mod._backend_port("codex"), mod._BRIDGE_PORT)
        self.assertEqual(mod._backend_port("gemini"), mod._BRIDGE_PORT)
        # The stale per-backend map (codex 9181, gemini 9182) is gone.
        self.assertEqual(mod._BACKEND_PORTS["codex"], mod._BRIDGE_PORT)
        self.assertEqual(mod._BACKEND_PORTS["gemini"], mod._BRIDGE_PORT)
