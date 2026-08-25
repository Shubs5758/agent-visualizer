"""
Ingestion & broadcast bridge — Python implementation.

Behaviourally identical to ``server/src/index.js``; the same protocol
conformance suite runs against both. This one exists so that ``pip install``
is all a consumer needs: it also serves the bundled dashboard, so there is no
Node, no npm, and no separate front-end process.

    producers (your agent code) --ws/http--> [ bridge ] --ws--> viewers (browser)

One port serves everything:

    GET  /                 dashboard (or a WebSocket, if the request upgrades)
    ws://host:port/        WebSocket; ``?role=viewer`` also receives a snapshot
    POST /ingest           fire-and-forget JSON ingest (one event or an array)
    GET  /health           liveness + counters
    GET  /state            current world snapshot as JSON

See ``protocol/PROTOCOL.md`` for the event schema.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

try:
    from aiohttp import WSMsgType, web
except ImportError as exc:  # pragma: no cover - surfaced as a friendly CLI error
    raise ImportError(
        "The bridge needs the 'server' extra:\n"
        '    pip install "agent-visualizer[server]"'
    ) from exc

log = logging.getLogger("agent_visualizer.bridge")

VERSION = "1.0.0"

DEFAULT_PORT = int(os.environ.get("VISUALIZER_PORT", "8765"))
DEFAULT_HOST = os.environ.get("VISUALIZER_HOST", "0.0.0.0")
REPLAY_BUFFER_SIZE = int(os.environ.get("VISUALIZER_BUFFER", "500"))
#: Frames a slow viewer may fall behind before we start dropping its oldest.
MAX_QUEUED_FRAMES = 512
HEARTBEAT_S = 30.0

PRODUCER_EVENTS = frozenset(
    {"register", "move", "communicate", "state_update", "graph_edge", "unregister", "reset"}
)

WEB_ROOT = Path(__file__).parent / "web"


# ---------------------------------------------------------------------------
# World state — what a late-joining viewer needs to catch up
# ---------------------------------------------------------------------------


class World:
    """Retained state folded from the event stream."""

    def __init__(self, buffer_size: int = REPLAY_BUFFER_SIZE) -> None:
        self.agents: Dict[str, Dict[str, Any]] = {}
        self.edges: Dict[str, Dict[str, Any]] = {}
        self.replay: List[Dict[str, Any]] = []
        self.buffer_size = buffer_size
        self.seq = 0
        self.counters = {"received": 0, "rejected": 0, "broadcast": 0}

    def reset(self) -> None:
        self.agents.clear()
        self.edges.clear()
        self.replay = []

    def apply(self, evt: Dict[str, Any]) -> None:
        """Fold one event into the retained state."""
        kind = evt.get("event")

        if kind == "register":
            prev = self.agents.get(evt["agent_id"], {})
            merged = {**prev, **evt, "event": "register", "online": True}
            self.agents[evt["agent_id"]] = merged

        elif kind == "move":
            prev = self.agents.get(evt["agent_id"])
            if prev and evt.get("target_pos"):
                # Record the destination so a reconnecting viewer spawns the
                # agent where it was heading, not where it started.
                prev["initial_pos"] = evt["target_pos"]

        elif kind == "state_update":
            prev = self.agents.get(evt["agent_id"])
            if prev:
                prev["status"] = evt.get("status")
                metrics = dict(prev.get("metrics") or {})
                metrics.update(evt.get("metrics") or {})
                if metrics:
                    prev["metrics"] = metrics

        elif kind == "graph_edge":
            self._bump_edge(evt["source"], evt["target"], evt.get("weight", 1), evt.get("label"))

        elif kind == "communicate":
            target = evt.get("target_agent_id")
            if target:
                self._bump_edge(evt["source_agent_id"], target, 1, None)

        elif kind == "unregister":
            prev = self.agents.get(evt["agent_id"])
            if prev:
                prev["online"] = False

        elif kind == "reset":
            self.reset()

    def _bump_edge(self, source: str, target: str, weight: Any, label: Optional[str]) -> None:
        key = f"{source}->{target}"
        prev = self.edges.get(key)
        prev_weight = prev.get("weight", 0) if prev else 0
        self.edges[key] = {
            "event": "graph_edge",
            "source": source,
            "target": target,
            "weight": prev_weight + (weight if isinstance(weight, (int, float)) else 1),
            "label": label if label is not None else (prev or {}).get("label"),
        }

    def remember(self, evt: Dict[str, Any]) -> None:
        if evt.get("event") == "reset":
            return
        self.replay.append(evt)
        if len(self.replay) > self.buffer_size:
            self.replay = self.replay[-self.buffer_size :]

    def snapshot(self) -> Dict[str, Any]:
        return {
            "event": "snapshot",
            "ts": int(time.time() * 1000),
            "agents": list(self.agents.values()),
            "edges": list(self.edges.values()),
            "recent": list(self.replay),
        }


# ---------------------------------------------------------------------------
# Validation — mirrors validate() in the Node bridge
# ---------------------------------------------------------------------------

_NEEDS_AGENT = ("register", "move", "state_update", "unregister")


def validate(raw: Any, world: World) -> Tuple[bool, Any]:
    """@returns ``(True, event)`` or ``(False, reason)``."""
    if not isinstance(raw, dict):
        return False, "payload must be a JSON object"

    kind = raw.get("event")
    if not isinstance(kind, str) or not kind:
        return False, 'missing "event" field'
    if kind not in PRODUCER_EVENTS:
        return False, f'unknown event type "{kind}"'
    if kind in _NEEDS_AGENT and not isinstance(raw.get("agent_id"), str):
        return False, f"{kind} requires agent_id"
    if kind == "communicate" and not isinstance(raw.get("source_agent_id"), str):
        return False, "communicate requires source_agent_id"
    if kind == "graph_edge" and not (
        isinstance(raw.get("source"), str) and isinstance(raw.get("target"), str)
    ):
        return False, "graph_edge requires source and target"

    event = dict(raw)
    if not isinstance(event.get("ts"), (int, float)):
        event["ts"] = int(time.time() * 1000)
    world.seq += 1
    event["seq"] = world.seq
    return True, event


# ---------------------------------------------------------------------------
# Client bookkeeping
# ---------------------------------------------------------------------------


class Client:
    """One connected socket, with a bounded outbound queue."""

    def __init__(self, ws: web.WebSocketResponse, role: str, name: str) -> None:
        self.ws = ws
        self.role = role
        self.name = name
        self.dropped = 0
        self.connected_at = time.time()
        self.queue: "asyncio.Queue[str]" = asyncio.Queue(maxsize=MAX_QUEUED_FRAMES)

    def offer(self, payload: str) -> bool:
        """Enqueue a frame, dropping this client's oldest when it falls behind."""
        try:
            self.queue.put_nowait(payload)
            return True
        except asyncio.QueueFull:
            try:
                self.queue.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:
                pass
            try:
                self.queue.put_nowait(payload)
                return True
            except asyncio.QueueFull:
                self.dropped += 1
                return False


class Bridge:
    def __init__(self, buffer_size: int = REPLAY_BUFFER_SIZE, cors_origin: str = "*") -> None:
        self.world = World(buffer_size)
        self.clients: Set[Client] = set()
        self.cors_origin = cors_origin

    # -- fan-out ---------------------------------------------------------

    @property
    def cors_headers(self) -> Dict[str, str]:
        return {
            "Access-Control-Allow-Origin": self.cors_origin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
        }

    def viewers(self) -> int:
        return sum(1 for c in self.clients if c.role == "viewer")

    def broadcast(self, event: Dict[str, Any], origin: Optional[Client]) -> None:
        payload = json.dumps(event)
        for client in self.clients:
            if client is origin:
                continue  # never echo to the producer that sent it
            if client.offer(payload):
                self.world.counters["broadcast"] += 1

    def ingest(self, raw: Any, origin: Optional[Client], label: str) -> Tuple[bool, Any]:
        """Single entry point for every event, whatever transport it arrived on."""
        self.world.counters["received"] += 1
        ok, result = validate(raw, self.world)
        if not ok:
            self.world.counters["rejected"] += 1
            log.warning("[ingest] rejected from %s: %s", label, result)
            return False, result

        self.world.apply(result)
        self.world.remember(result)
        self.broadcast(result, origin)
        return True, result

    def ingest_payload(
        self, parsed: Any, origin: Optional[Client], label: str
    ) -> Tuple[int, List[str]]:
        """Accepts one event or an array of events."""
        items = parsed if isinstance(parsed, list) else [parsed]
        accepted = 0
        errors: List[str] = []
        for item in items:
            ok, result = self.ingest(item, origin, label)
            if ok:
                accepted += 1
            else:
                errors.append(str(result))
        return accepted, errors

    def server_info(self) -> Dict[str, Any]:
        return {
            "event": "server_info",
            "ts": int(time.time() * 1000),
            "clients": len(self.clients),
            "viewers": self.viewers(),
            "buffered": len(self.world.replay),
            "version": VERSION,
        }

    def announce(self) -> None:
        payload = json.dumps(self.server_info())
        for client in self.clients:
            if client.role == "viewer":
                client.offer(payload)


# ---------------------------------------------------------------------------
# HTTP + WebSocket handlers
# ---------------------------------------------------------------------------


def build_app(bridge: Optional[Bridge] = None, serve_dashboard: bool = True) -> web.Application:
    bridge = bridge or Bridge()
    app = web.Application(client_max_size=4 * 1024 * 1024)
    app["bridge"] = bridge

    def json_response(data: Any, status: int = 200) -> web.Response:
        return web.json_response(data, status=status, headers=bridge.cors_headers)

    async def pump(client: Client) -> None:
        """Drain one client's queue onto its socket."""
        try:
            while True:
                payload = await client.queue.get()
                if client.ws.closed:
                    return
                await client.ws.send_str(payload)
        except (ConnectionResetError, asyncio.CancelledError):
            return
        except Exception as exc:  # pragma: no cover - defensive
            log.debug("send failed for %s %s: %s", client.role, client.name, exc)

    async def websocket(request: web.Request) -> web.WebSocketResponse:
        role = "viewer" if request.query.get("role") == "viewer" else "producer"
        name = request.query.get("client", "anonymous")

        ws = web.WebSocketResponse(heartbeat=HEARTBEAT_S, max_msg_size=4 * 1024 * 1024)
        await ws.prepare(request)

        client = Client(ws, role, name)
        bridge.clients.add(client)
        log.info("[ws] + %s %r (%d connected)", role, name, len(bridge.clients))

        if role == "viewer":
            # Catch the viewer up on everything it missed.
            client.offer(json.dumps(bridge.world.snapshot()))
        bridge.announce()

        pump_task = asyncio.ensure_future(pump(client))
        try:
            async for msg in ws:
                if msg.type is WSMsgType.TEXT:
                    try:
                        parsed = json.loads(msg.data)
                    except (ValueError, TypeError):
                        bridge.world.counters["rejected"] += 1
                        client.offer(
                            json.dumps(
                                {
                                    "event": "server_error",
                                    "ts": int(time.time() * 1000),
                                    "error": "invalid JSON",
                                }
                            )
                        )
                        continue
                    # A viewer may send events too — that is how the browser's
                    # mock simulator drives other connected viewers.
                    bridge.ingest_payload(parsed, client, f"{role}:{name}")
                elif msg.type is WSMsgType.ERROR:
                    log.warning("[ws] error from %s %r: %s", role, name, ws.exception())
        finally:
            pump_task.cancel()
            bridge.clients.discard(client)
            log.info("[ws] - %s %r (%d connected)", role, name, len(bridge.clients))
            bridge.announce()
        return ws

    async def health(request: web.Request) -> web.Response:
        return json_response(
            {
                "ok": True,
                "version": VERSION,
                "uptime_s": int(time.time() - app["started_at"]),
                "clients": len(bridge.clients),
                "viewers": bridge.viewers(),
                "agents": len(bridge.world.agents),
                "edges": len(bridge.world.edges),
                "buffered": len(bridge.world.replay),
                "counters": bridge.world.counters,
            }
        )

    async def state(request: web.Request) -> web.Response:
        return json_response(bridge.world.snapshot())

    async def ingest(request: web.Request) -> web.Response:
        try:
            parsed = json.loads(await request.text())
        except (ValueError, TypeError) as exc:
            return json_response({"accepted": 0, "errors": [str(exc)]}, status=400)
        accepted, errors = bridge.ingest_payload(parsed, None, "http")
        status = 400 if errors and not accepted else 202
        return json_response({"accepted": accepted, "errors": errors}, status=status)

    async def preflight(request: web.Request) -> web.Response:
        return web.Response(status=204, headers=bridge.cors_headers)

    async def root(request: web.Request) -> web.StreamResponse:
        """
        WebSocket clients connect to ``ws://host:port/`` (matching the Node
        bridge), so the same path has to serve both the upgrade and the
        dashboard's index.html.
        """
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return await websocket(request)
        index = WEB_ROOT / "index.html"
        if serve_dashboard and index.is_file():
            return web.FileResponse(index)
        return json_response(
            {
                "service": "agent-visualizer bridge",
                "version": VERSION,
                "dashboard": "not bundled in this build",
                "endpoints": ["GET /health", "GET /state", "POST /ingest", "WS /"],
            }
        )

    app.router.add_route("OPTIONS", "/{tail:.*}", preflight)
    app.router.add_get("/health", health)
    app.router.add_get("/state", state)
    app.router.add_post("/ingest", ingest)
    app.router.add_get("/ws", websocket)
    app.router.add_get("/", root)

    if serve_dashboard and WEB_ROOT.is_dir():
        # Registered last so it never shadows the API routes above.
        app.router.add_static("/", WEB_ROOT, show_index=False)

    async def _startup(_: web.Application) -> None:
        app["started_at"] = time.time()

    app["started_at"] = time.time()
    app.on_startup.append(_startup)
    return app


def dashboard_available() -> bool:
    return (WEB_ROOT / "index.html").is_file()


def serve(
    port: int = DEFAULT_PORT,
    host: str = DEFAULT_HOST,
    *,
    buffer_size: int = REPLAY_BUFFER_SIZE,
    cors_origin: str = "*",
    serve_dashboard: bool = True,
    print_banner: bool = True,
) -> None:
    """Run the bridge until interrupted. Blocks."""
    bridge = Bridge(buffer_size=buffer_size, cors_origin=cors_origin)
    app = build_app(bridge, serve_dashboard=serve_dashboard)

    if print_banner:
        shown = "localhost" if host in ("0.0.0.0", "::", "") else host
        has_ui = serve_dashboard and dashboard_available()
        print(
            f"\n  Agent Visualizer bridge v{VERSION}\n"
            f"  {'-' * 52}\n"
            + (
                f"  Dashboard     http://{shown}:{port}/\n"
                if has_ui
                else "  Dashboard     (not bundled — run the Vite dev server)\n"
            )
            + f"  WebSocket     ws://{shown}:{port}/\n"
            f"  HTTP ingest   POST http://{shown}:{port}/ingest\n"
            f"  Health        GET  http://{shown}:{port}/health\n"
        )

    try:
        web.run_app(app, host=host, port=port, print=None, access_log=None)
    except KeyboardInterrupt:  # pragma: no cover
        pass


if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    serve()
