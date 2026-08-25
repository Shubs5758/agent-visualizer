"""
agent_visualizer.client — drop-in client for the 2D Retro AI Agent Visualizer.

Design goals, in priority order:

1. **Never break the host program.** Every public method is fire-and-forget and
   swallows transport errors. If the visualizer is not running, your agent code
   still runs at full speed.
2. **Zero required dependencies.** If ``websocket-client`` is installed the
   client speaks WebSocket; otherwise it silently falls back to HTTP POST using
   only the standard library.
3. **Two lines to integrate.**

Direct use::

    from agent_visualizer import AgentVisualizerClient

    vis = AgentVisualizerClient("ws://localhost:8765")
    scout = vis.register("scout_1", name="Scout", role="scout", avatar_type="rogue")
    scout.move_to(zone="library")
    scout.update_state("Executing Tool: WebSearch", metrics={"tokens": 320})
    scout.speak("Found the target node.", to="mage_1")

LangChain / LangGraph use::

    from agent_visualizer import VisualizerCallback

    vis = VisualizerCallback(server_url="ws://localhost:8765")
    graph.invoke(state, config={"callbacks": [vis]})

See ``../../protocol/PROTOCOL.md`` for the wire format.
"""

from __future__ import annotations

import atexit
import json
import logging
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib import request as _urlrequest
from urllib.error import URLError

__all__ = [
    "AgentVisualizerClient",
    "AgentHandle",
    "VisualizerCallback",
    "visualize_agent",
    "ZONES",
    "AVATAR_TYPES",
]

__version__ = "1.0.0"

log = logging.getLogger("agent_visualizer")

DEFAULT_SERVER_URL = "ws://localhost:8765"

#: Interaction zones understood by ``move_to(zone=...)``. Mirrors PROTOCOL.md §5.
ZONES: Tuple[str, ...] = ("gateway", "library", "tools", "council", "vault")

#: Sprite archetypes. Unknown values are hashed onto this list by the renderer.
AVATAR_TYPES: Tuple[str, ...] = (
    "knight",
    "artificer",
    "rogue",
    "cleric",
    "bard",
    "ranger",
    "mage",
    "druid",
)

GRID_COLS, GRID_ROWS = 25, 18


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------


#: Events coalesced into a single transmission by the sender thread.
_MAX_BATCH = 64

_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1", "[::1]")


def _prefer_ipv4_loopback(url: str) -> str:
    """
    Rewrite ``localhost`` to ``127.0.0.1``.

    ``localhost`` resolves to ``::1`` first on Windows and most modern Linux
    distributions. If the bridge happens to be bound IPv4-only, every single
    request pays a ~2 second failed-connect before falling back — which is
    indistinguishable from a broken server. Pinning the loopback literal makes
    the fallback transport predictable regardless of how the server was bound.
    """
    return url.replace("//localhost:", "//127.0.0.1:").replace("//localhost/", "//127.0.0.1/")


def _is_loopback(url: str) -> bool:
    host = url.split("//", 1)[-1].split("/", 1)[0].rsplit("@", 1)[-1]
    host = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    return host in _LOOPBACK_HOSTS


class _Transport:
    """Minimal interface the sender thread drives."""

    name = "null"

    def connect(self) -> None: ...

    def send(self, payload: str) -> None: ...

    def send_batch(self, payloads: Sequence[str]) -> None:
        """Transmit several already-serialised events. Overridden where batching wins."""
        for payload in payloads:
            self.send(payload)

    def close(self) -> None: ...

    @property
    def connected(self) -> bool:
        return False


class _WebSocketTransport(_Transport):
    """Backed by the ``websocket-client`` package (``pip install websocket-client``)."""

    name = "websocket"

    def __init__(self, url: str, client_name: str, timeout: float = 5.0):
        self._url = _prefer_ipv4_loopback(url)
        self._client_name = client_name
        self._timeout = timeout
        self._ws: Any = None

    def connect(self) -> None:
        import websocket  # type: ignore[import-not-found]

        sep = "&" if "?" in self._url else "?"
        full = f"{self._url}{sep}role=producer&client={self._client_name}"
        self._ws = websocket.create_connection(full, timeout=self._timeout)
        # Reads are not used, but a short timeout keeps close() responsive.
        self._ws.settimeout(self._timeout)

    def send(self, payload: str) -> None:
        if self._ws is None:
            raise ConnectionError("not connected")
        self._ws.send(payload)

    def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                ws.close()
            except Exception:  # pragma: no cover - best effort
                pass

    @property
    def connected(self) -> bool:
        return self._ws is not None


class _HttpTransport(_Transport):
    """
    Standard-library fallback: POST each event to ``/ingest``.

    Slower than the WebSocket transport (one request per flush) but requires
    nothing to be installed, which keeps the "just import it" promise true.
    """

    name = "http"

    def __init__(self, url: str, timeout: float = 3.0):
        self._url = _prefer_ipv4_loopback(url)
        self._timeout = timeout
        self._ok = False
        # A corporate HTTP_PROXY must never swallow traffic aimed at a bridge
        # running on this machine, so loopback gets an opener with proxies off.
        self._opener = (
            _urlrequest.build_opener(_urlrequest.ProxyHandler({}))
            if _is_loopback(self._url)
            else _urlrequest.build_opener()
        )

    def connect(self) -> None:
        # There is no persistent connection; probe /health so failures surface
        # in the same place as WebSocket connection failures.
        health = self._url.rsplit("/ingest", 1)[0] + "/health"
        with self._opener.open(health, timeout=self._timeout):
            pass
        self._ok = True

    def _post(self, body: str) -> None:
        req = _urlrequest.Request(
            self._url,
            data=body.encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self._opener.open(req, timeout=self._timeout):
            pass

    def send(self, payload: str) -> None:
        self._post(payload)

    def send_batch(self, payloads: Sequence[str]) -> None:
        if not payloads:
            return
        if len(payloads) == 1:
            self._post(payloads[0])
            return
        # The bridge accepts a JSON array, so a burst costs one request instead
        # of one per event. The payloads are already serialised — splicing the
        # strings avoids a pointless decode/encode round trip.
        self._post("[" + ",".join(payloads) + "]")

    def close(self) -> None:
        self._ok = False

    @property
    def connected(self) -> bool:
        return self._ok


def _http_url_from_ws(url: str) -> str:
    base = url
    if base.startswith("ws://"):
        base = "http://" + base[len("ws://") :]
    elif base.startswith("wss://"):
        base = "https://" + base[len("wss://") :]
    base = base.split("?", 1)[0].rstrip("/")
    return base + "/ingest"


def _select_transport(url: str, client_name: str, prefer: str = "auto") -> _Transport:
    if prefer in ("auto", "websocket"):
        try:
            import websocket  # noqa: F401
        except ImportError:
            if prefer == "websocket":
                raise RuntimeError(
                    "transport='websocket' requires: pip install websocket-client"
                )
            log.info(
                "agent_visualizer: websocket-client not installed, "
                "falling back to HTTP ingest (pip install websocket-client for lower latency)"
            )
        else:
            return _WebSocketTransport(url, client_name)
    return _HttpTransport(_http_url_from_ws(url))


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


@dataclass
class AgentHandle:
    """Fluent, per-agent wrapper returned by :meth:`AgentVisualizerClient.register`."""

    agent_id: str
    _client: "AgentVisualizerClient" = field(repr=False)

    def move_to(
        self,
        x: Optional[int] = None,
        y: Optional[int] = None,
        *,
        zone: Optional[str] = None,
        speed: float = 1.0,
    ) -> "AgentHandle":
        self._client.move_to(self.agent_id, x, y, zone=zone, speed=speed)
        return self

    def speak(
        self,
        message: str,
        *,
        to: Optional[str] = None,
        interaction_type: str = "dialogue",
    ) -> "AgentHandle":
        self._client.speak(self.agent_id, message, to=to, interaction_type=interaction_type)
        return self

    def update_state(
        self,
        status: str,
        *,
        detail: Optional[str] = None,
        metrics: Optional[Dict[str, float]] = None,
    ) -> "AgentHandle":
        self._client.update_state(self.agent_id, status, detail=detail, metrics=metrics)
        return self

    # Convenience aliases that read well in agent code.
    set_state = update_state

    def uses_tool(self, tool_name: str, **metrics: float) -> "AgentHandle":
        self.move_to(zone="tools")
        return self.update_state(f"Executing Tool: {tool_name}", metrics=metrics or None)

    def unregister(self) -> None:
        self._client.unregister(self.agent_id)


class AgentVisualizerClient:
    """
    Non-blocking event producer.

    Public methods only enqueue; a daemon thread owns the socket, reconnects
    with exponential backoff, and drains the queue. Nothing here blocks your
    agent loop and nothing here raises.

    Args:
        server_url: WebSocket URL of the bridge.
        run_id: Groups events from one execution. Auto-generated if omitted.
        client_name: Shown in the server log.
        transport: ``"auto"`` (default), ``"websocket"`` or ``"http"``.
        queue_size: Max buffered events while disconnected. Oldest are dropped.
        enabled: Set ``False`` to make every call a no-op (useful in prod).
        auto_register: Emit a ``register`` automatically the first time an
            unknown ``agent_id`` is referenced.
    """

    def __init__(
        self,
        server_url: str = DEFAULT_SERVER_URL,
        *,
        run_id: Optional[str] = None,
        client_name: str = "python-sdk",
        transport: str = "auto",
        queue_size: int = 10_000,
        enabled: bool = True,
        auto_register: bool = True,
        connect_timeout: float = 5.0,
    ) -> None:
        self.server_url = server_url
        self.run_id = run_id or uuid.uuid4().hex[:12]
        self.enabled = enabled
        self.auto_register = auto_register

        self._queue: "queue.Queue[str]" = queue.Queue(maxsize=queue_size)
        self._stop = threading.Event()
        self._connected = threading.Event()
        self._known_agents: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._dropped = 0
        self._sent = 0
        self._transport_pref = transport
        self._client_name = client_name
        self._connect_timeout = connect_timeout
        self._transport: Optional[_Transport] = None

        self._thread: Optional[threading.Thread] = None
        if self.enabled:
            self._thread = threading.Thread(
                target=self._run, name="visualizer-sender", daemon=True
            )
            self._thread.start()
            atexit.register(self.close)

    # -- lifecycle ---------------------------------------------------------

    def _run(self) -> None:
        backoff = 0.5
        while not self._stop.is_set():
            try:
                self._transport = _select_transport(
                    self.server_url, self._client_name, self._transport_pref
                )
                self._transport.connect()
                self._connected.set()
                log.info(
                    "agent_visualizer: connected to %s via %s",
                    self.server_url,
                    self._transport.name,
                )
                backoff = 0.5
                self._replay_known_agents()
                self._drain()
            except (OSError, URLError, ConnectionError, RuntimeError) as exc:
                self._connected.clear()
                if self._stop.is_set():
                    break
                log.debug("agent_visualizer: connection failed (%s); retrying in %.1fs", exc, backoff)
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)
            except Exception as exc:  # pragma: no cover - defensive
                self._connected.clear()
                log.debug("agent_visualizer: unexpected sender error: %s", exc)
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)
            finally:
                self._connected.clear()
                if self._transport is not None:
                    self._transport.close()

    def _drain(self) -> None:
        """Pump the queue until the transport fails or we are asked to stop."""
        assert self._transport is not None
        while not self._stop.is_set():
            try:
                first = self._queue.get(timeout=0.25)
            except queue.Empty:
                continue

            # Coalesce whatever else is already waiting. A busy agent emits
            # events in bursts, and this turns a burst into one transmission.
            batch = [first]
            while len(batch) < _MAX_BATCH:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break

            try:
                self._transport.send_batch(batch)
                self._sent += len(batch)
            except Exception:
                # Put them back so the events are not lost, then bubble up to
                # trigger a reconnect.
                for payload in reversed(batch):
                    self._offer(payload)
                raise ConnectionError("send failed")

    def _replay_known_agents(self) -> None:
        """
        After a reconnect the server may have restarted and lost the roster.
        Re-announce every agent we have registered so the scene repopulates.
        """
        with self._lock:
            snapshot = list(self._known_agents.values())
        for evt in snapshot:
            self._offer(json.dumps(evt))

    def close(self, timeout: float = 2.0) -> None:
        """Flush what we can, then stop the sender thread. Safe to call twice."""
        if self._stop.is_set():
            return
        deadline = time.monotonic() + timeout
        while not self._queue.empty() and time.monotonic() < deadline:
            time.sleep(0.02)
        self._stop.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=max(0.0, deadline - time.monotonic()) + 0.5)

    def __enter__(self) -> "AgentVisualizerClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- plumbing ----------------------------------------------------------

    def _offer(self, payload: str) -> None:
        """Enqueue, dropping the oldest event when the buffer is full."""
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            try:
                self._queue.get_nowait()
                self._dropped += 1
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(payload)
            except queue.Full:
                self._dropped += 1

    def emit(self, event: Dict[str, Any]) -> None:
        """Escape hatch: send an arbitrary protocol event."""
        if not self.enabled:
            return
        try:
            event.setdefault("ts", int(time.time() * 1000))
            event.setdefault("run_id", self.run_id)
            self._offer(json.dumps(event, default=str))
        except Exception as exc:  # pragma: no cover - never break the host
            log.debug("agent_visualizer: failed to emit %r: %s", event.get("event"), exc)

    def _ensure_agent(self, agent_id: str) -> None:
        if not self.auto_register:
            return
        with self._lock:
            known = agent_id in self._known_agents
        if not known:
            self.register(agent_id)

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    @property
    def stats(self) -> Dict[str, Any]:
        return {
            "connected": self.connected,
            "transport": self._transport.name if self._transport else None,
            "sent": self._sent,
            "queued": self._queue.qsize(),
            "dropped": self._dropped,
            "agents": len(self._known_agents),
            "run_id": self.run_id,
        }

    # -- protocol methods --------------------------------------------------

    def register(
        self,
        agent_id: str,
        *,
        name: Optional[str] = None,
        role: Optional[str] = None,
        avatar_type: Optional[str] = None,
        initial_pos: Optional[Dict[str, int]] = None,
        color: Optional[str] = None,
    ) -> AgentHandle:
        """REGISTER_AGENT — spawn (or update) an agent sprite."""
        event: Dict[str, Any] = {
            "event": "register",
            "agent_id": agent_id,
            "name": name or agent_id,
            "role": role or "agent",
            "avatar_type": avatar_type or _avatar_for(agent_id),
        }
        if initial_pos:
            event["initial_pos"] = {
                "x": max(0, min(GRID_COLS - 1, int(initial_pos.get("x", 0)))),
                "y": max(0, min(GRID_ROWS - 1, int(initial_pos.get("y", 0)))),
            }
        if color:
            event["color"] = color

        with self._lock:
            self._known_agents[agent_id] = dict(event)
        self.emit(event)
        return AgentHandle(agent_id, self)

    def agent(self, agent_id: str, **kwargs: Any) -> AgentHandle:
        """Return a handle, registering the agent on first use."""
        with self._lock:
            known = agent_id in self._known_agents
        if known and not kwargs:
            return AgentHandle(agent_id, self)
        return self.register(agent_id, **kwargs)

    def move_to(
        self,
        agent_id: str,
        x: Optional[int] = None,
        y: Optional[int] = None,
        *,
        zone: Optional[str] = None,
        speed: float = 1.0,
    ) -> None:
        """AGENT_MOVE — walk to a tile, or to a named zone."""
        if x is None and y is None and zone is None:
            log.debug("agent_visualizer: move_to needs coordinates or a zone")
            return
        self._ensure_agent(agent_id)
        event: Dict[str, Any] = {"event": "move", "agent_id": agent_id, "speed": float(speed)}
        if x is not None and y is not None:
            event["target_pos"] = {
                "x": max(0, min(GRID_COLS - 1, int(x))),
                "y": max(0, min(GRID_ROWS - 1, int(y))),
            }
        elif zone is not None:
            event["target_zone"] = zone
        self.emit(event)

    def speak(
        self,
        source_agent_id: str,
        message: str,
        *,
        to: Optional[str] = None,
        interaction_type: str = "dialogue",
    ) -> None:
        """AGENT_COMMUNICATE — walk over to ``to`` (if given) and show a bubble."""
        self._ensure_agent(source_agent_id)
        if to:
            self._ensure_agent(to)
        self.emit(
            {
                "event": "communicate",
                "source_agent_id": source_agent_id,
                "target_agent_id": to,
                "message": str(message),
                "interaction_type": interaction_type,
            }
        )

    def update_state(
        self,
        agent_id: str,
        status: str,
        *,
        detail: Optional[str] = None,
        metrics: Optional[Dict[str, float]] = None,
    ) -> None:
        """AGENT_STATE_UPDATE — status tag above the sprite + roster/feed entry."""
        self._ensure_agent(agent_id)
        event: Dict[str, Any] = {
            "event": "state_update",
            "agent_id": agent_id,
            "status": str(status),
        }
        if detail:
            event["detail"] = str(detail)[:2000]
        if metrics:
            clean = {k: float(v) for k, v in metrics.items() if isinstance(v, (int, float))}
            if clean:
                event["metrics"] = clean
        self.emit(event)

    def graph_edge(
        self,
        source: str,
        target: str,
        weight: float = 1.0,
        label: Optional[str] = None,
    ) -> None:
        """GRAPH_UPDATE — declare a collaboration edge."""
        event: Dict[str, Any] = {
            "event": "graph_edge",
            "source": source,
            "target": target,
            "weight": float(weight),
        }
        if label:
            event["label"] = label
        self.emit(event)

    def unregister(self, agent_id: str) -> None:
        with self._lock:
            self._known_agents.pop(agent_id, None)
        self.emit({"event": "unregister", "agent_id": agent_id})

    def reset(self) -> None:
        """Clear the world. Call at the start of a run to drop stale agents."""
        with self._lock:
            self._known_agents.clear()
        self.emit({"event": "reset"})


def _avatar_for(seed: str) -> str:
    """Deterministic archetype assignment, so an agent looks the same every run."""
    h = 0
    for ch in seed:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return AVATAR_TYPES[h % len(AVATAR_TYPES)]


# ---------------------------------------------------------------------------
# LangChain / LangGraph integration
# ---------------------------------------------------------------------------

try:  # pragma: no cover - depends on the host environment
    from langchain_core.callbacks.base import BaseCallbackHandler as _BaseCallbackHandler
except Exception:  # pragma: no cover
    try:
        from langchain.callbacks.base import BaseCallbackHandler as _BaseCallbackHandler
    except Exception:
        class _BaseCallbackHandler:  # type: ignore[no-redef]
            """Stand-in so the module imports cleanly without LangChain."""

            raise_error = False
            run_inline = False


#: Which zone an activity happens in. Drives the walking animation.
_ACTIVITY_ZONES = {
    "tool": "tools",
    "retriever": "library",
    "llm": "council",
    "chain": "council",
    "finish": "vault",
}

_ROLE_HINTS = (
    ("plan", "planner"),
    ("research", "researcher"),
    ("search", "scout"),
    ("scout", "scout"),
    ("critic", "critic"),
    ("review", "critic"),
    ("write", "writer"),
    ("summar", "writer"),
    ("code", "engineer"),
    ("tool", "operator"),
    ("supervis", "supervisor"),
    ("router", "supervisor"),
)


def _infer_role(name: str) -> str:
    lowered = name.lower()
    for needle, role in _ROLE_HINTS:
        if needle in lowered:
            return role
    return "agent"


def _truncate(value: Any, limit: int = 180) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


class VisualizerCallback(_BaseCallbackHandler):  # type: ignore[misc]
    """
    LangChain / LangGraph callback handler that renders a run automatically.

    Drop it into any ``config={"callbacks": [...]}`` and it will:

    * spawn one sprite per **LangGraph node** (or per named chain / agent),
    * walk that sprite to the Tool Forge on ``on_tool_start`` and to the
      Library on ``on_retriever_start``,
    * show the tool result / LLM output as a speech bubble,
    * accumulate token counts and per-step latency into the metrics feed,
    * draw graph edges as control passes from one node to the next.

    Usage::

        vis = VisualizerCallback(server_url="ws://localhost:8765")
        graph.invoke(state, config={"callbacks": [vis]})

    Args:
        server_url: bridge URL, or pass an existing ``client=`` instead.
        client: reuse an existing :class:`AgentVisualizerClient`.
        reset_on_start: emit ``reset`` when the outermost chain begins.
        show_thoughts: bubble LLM output as well as tool activity.
        root_agent_id: sprite used for activity that has no identifiable node.
    """

    raise_error = False

    def __init__(
        self,
        server_url: str = DEFAULT_SERVER_URL,
        *,
        client: Optional[AgentVisualizerClient] = None,
        reset_on_start: bool = True,
        show_thoughts: bool = True,
        root_agent_id: str = "orchestrator",
        **client_kwargs: Any,
    ) -> None:
        super().__init__()
        self.client = client or AgentVisualizerClient(server_url, **client_kwargs)
        self.reset_on_start = reset_on_start
        self.show_thoughts = show_thoughts
        self.root_agent_id = root_agent_id

        self._run_agent: Dict[str, str] = {}
        self._run_started: Dict[str, float] = {}
        self._tokens: Dict[str, float] = {}
        self._last_agent: Optional[str] = None
        self._root_run: Optional[str] = None
        self._lock = threading.Lock()

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _key(run_id: Any) -> str:
        return str(run_id)

    def _resolve_agent(
        self,
        serialized: Optional[Dict[str, Any]],
        metadata: Optional[Dict[str, Any]],
        tags: Optional[Sequence[str]],
        parent_run_id: Any,
        fallback: str,
    ) -> str:
        meta = metadata or {}
        # LangGraph stamps the node name into metadata; that is the best signal.
        for key in ("agent_id", "agent_name", "langgraph_node", "node", "name"):
            value = meta.get(key)
            if isinstance(value, str) and value and not value.startswith("__"):
                return value
        for tag in tags or ():
            if isinstance(tag, str) and tag.startswith("agent:"):
                return tag.split(":", 1)[1]
        parent = self._run_agent.get(self._key(parent_run_id)) if parent_run_id else None
        if parent:
            return parent
        name = (serialized or {}).get("name")
        if isinstance(name, str) and name:
            return name
        return fallback

    def _bind(self, run_id: Any, agent_id: str, *, avatar: Optional[str] = None) -> AgentHandle:
        key = self._key(run_id)
        with self._lock:
            self._run_agent[key] = agent_id
            self._run_started[key] = time.monotonic()
            previous = self._last_agent
            self._last_agent = agent_id

        handle = self.client.agent(
            agent_id,
            name=agent_id.replace("_", " ").title(),
            role=_infer_role(agent_id),
            avatar_type=avatar or _avatar_for(agent_id),
        )
        if previous and previous != agent_id:
            self.client.graph_edge(previous, agent_id, weight=1.0)
        return handle

    def _elapsed_ms(self, run_id: Any) -> Optional[float]:
        started = self._run_started.pop(self._key(run_id), None)
        if started is None:
            return None
        return round((time.monotonic() - started) * 1000, 1)

    def _agent_for(self, run_id: Any) -> str:
        return self._run_agent.get(self._key(run_id), self.root_agent_id)

    def _metrics(self, agent_id: str, run_id: Any, extra_tokens: float = 0.0) -> Dict[str, float]:
        metrics: Dict[str, float] = {}
        latency = self._elapsed_ms(run_id)
        if latency is not None:
            metrics["latency_ms"] = latency
        if extra_tokens:
            with self._lock:
                self._tokens[agent_id] = self._tokens.get(agent_id, 0.0) + extra_tokens
            metrics["tokens"] = self._tokens[agent_id]
        return metrics

    # -- chain -------------------------------------------------------------

    def on_chain_start(
        self,
        serialized: Optional[Dict[str, Any]] = None,
        inputs: Any = None,
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        tags: Optional[Sequence[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        try:
            if parent_run_id is None:
                if self.reset_on_start and self._root_run is None:
                    self.client.reset()
                    with self._lock:
                        self._run_agent.clear()
                        self._tokens.clear()
                        self._last_agent = None
                self._root_run = self._key(run_id)

            agent_id = self._resolve_agent(
                serialized, metadata, tags, parent_run_id, self.root_agent_id
            )
            handle = self._bind(run_id, agent_id)
            handle.move_to(zone=_ACTIVITY_ZONES["chain"])
            handle.update_state(f"Running: {agent_id}", detail=_truncate(inputs, 400))
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_chain_start: %s", exc)

    def on_chain_end(
        self,
        outputs: Any = None,
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> None:
        try:
            agent_id = self._agent_for(run_id)
            metrics = self._metrics(agent_id, run_id)
            handle = self.client.agent(agent_id)
            if parent_run_id is None:
                self._root_run = None
                handle.move_to(zone=_ACTIVITY_ZONES["finish"])
                handle.update_state("Complete", detail=_truncate(outputs, 400), metrics=metrics)
                handle.speak(_truncate(outputs, 120), interaction_type="broadcast")
            else:
                handle.update_state("Idle", detail=_truncate(outputs, 400), metrics=metrics)
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_chain_end: %s", exc)

    def on_chain_error(self, error: BaseException, *, run_id: Any = None, **kwargs: Any) -> None:
        self._report_error(run_id, error)

    # -- llm ---------------------------------------------------------------

    def on_llm_start(
        self,
        serialized: Optional[Dict[str, Any]] = None,
        prompts: Optional[List[str]] = None,
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        tags: Optional[Sequence[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        try:
            agent_id = self._resolve_agent(
                serialized, metadata, tags, parent_run_id, self._last_agent or self.root_agent_id
            )
            handle = self._bind(run_id, agent_id)
            model = (metadata or {}).get("ls_model_name") or (serialized or {}).get("name") or "LLM"
            handle.move_to(zone=_ACTIVITY_ZONES["llm"])
            handle.update_state(
                f"Thinking · {model}",
                detail=_truncate(prompts[0], 400) if prompts else None,
            )
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_llm_start: %s", exc)

    # Chat models route through a separate hook in LangChain.
    def on_chat_model_start(
        self,
        serialized: Optional[Dict[str, Any]] = None,
        messages: Any = None,
        **kwargs: Any,
    ) -> None:
        prompt = None
        try:
            first = messages[0][-1] if messages else None
            prompt = getattr(first, "content", None)
        except Exception:
            pass
        self.on_llm_start(serialized, [prompt] if isinstance(prompt, str) else None, **kwargs)

    def on_llm_end(self, response: Any = None, *, run_id: Any = None, **kwargs: Any) -> None:
        try:
            agent_id = self._agent_for(run_id)
            tokens = _extract_tokens(response)
            metrics = self._metrics(agent_id, run_id, extra_tokens=tokens)
            text = _extract_text(response)
            handle = self.client.agent(agent_id)
            handle.update_state("Reasoned", detail=_truncate(text, 600), metrics=metrics)
            if self.show_thoughts and text:
                handle.speak(_truncate(text, 110), interaction_type="dialogue")
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_llm_end: %s", exc)

    def on_llm_error(self, error: BaseException, *, run_id: Any = None, **kwargs: Any) -> None:
        self._report_error(run_id, error)

    # -- tools -------------------------------------------------------------

    def on_tool_start(
        self,
        serialized: Optional[Dict[str, Any]] = None,
        input_str: Any = None,
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        tags: Optional[Sequence[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        try:
            agent_id = self._resolve_agent(
                None, metadata, tags, parent_run_id, self._last_agent or self.root_agent_id
            )
            tool_name = (serialized or {}).get("name", "tool")
            key = self._key(run_id)
            with self._lock:
                self._run_agent[key] = agent_id
                self._run_started[key] = time.monotonic()
            handle = self.client.agent(agent_id)
            handle.move_to(zone=_ACTIVITY_ZONES["tool"])
            handle.update_state(
                f"Executing Tool: {tool_name}", detail=_truncate(input_str, 400)
            )
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_tool_start: %s", exc)

    def on_tool_end(self, output: Any = None, *, run_id: Any = None, **kwargs: Any) -> None:
        try:
            agent_id = self._agent_for(run_id)
            metrics = self._metrics(agent_id, run_id)
            handle = self.client.agent(agent_id)
            handle.update_state("Tool complete", detail=_truncate(output, 600), metrics=metrics)
            handle.speak(_truncate(output, 110), interaction_type="response")
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_tool_end: %s", exc)

    def on_tool_error(self, error: BaseException, *, run_id: Any = None, **kwargs: Any) -> None:
        self._report_error(run_id, error)

    # -- retriever ---------------------------------------------------------

    def on_retriever_start(
        self,
        serialized: Optional[Dict[str, Any]] = None,
        query: Any = None,
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        tags: Optional[Sequence[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        try:
            agent_id = self._resolve_agent(
                None, metadata, tags, parent_run_id, self._last_agent or self.root_agent_id
            )
            with self._lock:
                self._run_agent[self._key(run_id)] = agent_id
                self._run_started[self._key(run_id)] = time.monotonic()
            handle = self.client.agent(agent_id)
            handle.move_to(zone=_ACTIVITY_ZONES["retriever"])
            handle.update_state("Searching memory", detail=_truncate(query, 200))
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_retriever_start: %s", exc)

    def on_retriever_end(self, documents: Any = None, *, run_id: Any = None, **kwargs: Any) -> None:
        try:
            agent_id = self._agent_for(run_id)
            count = len(documents) if isinstance(documents, (list, tuple)) else 0
            metrics = self._metrics(agent_id, run_id)
            metrics["documents"] = float(count)
            self.client.update_state(
                agent_id, f"Retrieved {count} document(s)", metrics=metrics
            )
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_retriever_end: %s", exc)

    # -- agent actions -----------------------------------------------------

    def on_agent_action(self, action: Any = None, *, run_id: Any = None, **kwargs: Any) -> None:
        try:
            agent_id = self._agent_for(run_id)
            tool = getattr(action, "tool", "tool")
            thought = getattr(action, "log", "") or ""
            self.client.speak(agent_id, _truncate(thought or f"Calling {tool}", 110),
                              interaction_type="request")
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_agent_action: %s", exc)

    def on_agent_finish(self, finish: Any = None, *, run_id: Any = None, **kwargs: Any) -> None:
        try:
            agent_id = self._agent_for(run_id)
            output = getattr(finish, "return_values", finish)
            handle = self.client.agent(agent_id)
            handle.move_to(zone=_ACTIVITY_ZONES["finish"])
            handle.update_state("Finished", detail=_truncate(output, 400))
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback.on_agent_finish: %s", exc)

    # -- errors ------------------------------------------------------------

    def _report_error(self, run_id: Any, error: BaseException) -> None:
        try:
            agent_id = self._agent_for(run_id)
            self.client.update_state(
                agent_id,
                f"Error: {type(error).__name__}",
                detail=_truncate(str(error), 400),
                metrics=self._metrics(agent_id, run_id),
            )
            self.client.speak(agent_id, _truncate(str(error), 100), interaction_type="broadcast")
        except Exception as exc:  # pragma: no cover
            log.debug("VisualizerCallback._report_error: %s", exc)

    # -- passthrough -------------------------------------------------------

    def close(self) -> None:
        self.client.close()


def _extract_tokens(response: Any) -> float:
    """Pull a token count out of an LLMResult across LangChain versions."""
    try:
        usage = (getattr(response, "llm_output", None) or {}).get("token_usage") or {}
        total = usage.get("total_tokens")
        if isinstance(total, (int, float)):
            return float(total)
        generations = getattr(response, "generations", None) or []
        for group in generations:
            for gen in group:
                message = getattr(gen, "message", None)
                meta = getattr(message, "usage_metadata", None) if message else None
                if isinstance(meta, dict) and "total_tokens" in meta:
                    return float(meta["total_tokens"])
    except Exception:
        pass
    return 0.0


def _extract_text(response: Any) -> str:
    try:
        generations = getattr(response, "generations", None) or []
        for group in generations:
            for gen in group:
                text = getattr(gen, "text", None)
                if text:
                    return str(text)
                message = getattr(gen, "message", None)
                content = getattr(message, "content", None) if message else None
                if content:
                    return str(content)
    except Exception:
        pass
    return ""


# ---------------------------------------------------------------------------
# Decorator for plain (non-LangChain) code
# ---------------------------------------------------------------------------


def visualize_agent(
    agent_id: str,
    *,
    client: Optional[AgentVisualizerClient] = None,
    server_url: str = DEFAULT_SERVER_URL,
    role: Optional[str] = None,
    avatar_type: Optional[str] = None,
    zone: Optional[str] = "council",
    speak_result: bool = True,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """
    Decorate any function so calling it animates an agent.

    ::

        @visualize_agent("scout_1", role="scout", avatar_type="rogue")
        def scout(query: str) -> str:
            ...
    """
    shared = client

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        import functools

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            nonlocal shared
            if shared is None:
                shared = _default_client(server_url)
            handle = shared.agent(
                agent_id,
                name=agent_id.replace("_", " ").title(),
                role=role or _infer_role(agent_id),
                avatar_type=avatar_type or _avatar_for(agent_id),
            )
            if zone:
                handle.move_to(zone=zone)
            handle.update_state(f"Running: {fn.__name__}")
            started = time.monotonic()
            try:
                result = fn(*args, **kwargs)
            except Exception as exc:
                handle.update_state(
                    f"Error: {type(exc).__name__}", detail=_truncate(str(exc), 300)
                )
                raise
            latency = round((time.monotonic() - started) * 1000, 1)
            handle.update_state(
                f"Done: {fn.__name__}",
                detail=_truncate(result, 400),
                metrics={"latency_ms": latency},
            )
            if speak_result and result is not None:
                handle.speak(_truncate(result, 110))
            return result

        return wrapper

    return decorator


_DEFAULT_CLIENT: Optional[AgentVisualizerClient] = None
_DEFAULT_LOCK = threading.Lock()


def _default_client(server_url: str = DEFAULT_SERVER_URL) -> AgentVisualizerClient:
    """Process-wide client, created on first use by :func:`visualize_agent`."""
    global _DEFAULT_CLIENT
    with _DEFAULT_LOCK:
        if _DEFAULT_CLIENT is None:
            _DEFAULT_CLIENT = AgentVisualizerClient(server_url, client_name="decorator")
        return _DEFAULT_CLIENT
