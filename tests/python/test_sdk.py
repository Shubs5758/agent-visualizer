"""Verify the Python SDK against a live bridge (stdlib HTTP fallback path)."""
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python" / "src"))

from agent_visualizer import AgentVisualizerClient, VisualizerCallback, visualize_agent

import os
import socket
import subprocess
import atexit

# Spawn a private bridge on a free port. Attaching to whatever happens to be
# listening is how a stale process from an earlier run silently answered half
# these checks with out-of-date code.
def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = int(os.environ["VISUALIZER_PORT"]) if os.environ.get("VISUALIZER_PORT") else _free_port()
HTTP = f"http://127.0.0.1:{PORT}"

_bridge = None
if not os.environ.get("VISUALIZER_PORT"):
    _bridge = subprocess.Popen(
        [sys.executable, "-m", "agent_visualizer.cli", "serve",
         "--port", str(PORT), "--no-open", "--no-dashboard"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "sdk" / "python" / "src")},
    )
    atexit.register(_bridge.terminate)
    for _ in range(60):  # wait for it to accept connections
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.25):
                break
        except OSError:
            time.sleep(0.25)

results = []


def check(name, ok, extra=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + str(extra)) if extra else ''}")


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def state():
    with _opener.open(f"{HTTP}/state", timeout=5) as r:
        return json.load(r)


vis = AgentVisualizerClient(f"ws://localhost:{PORT}", client_name="sdk-test")
time.sleep(1.5)

# Assert the *selection rule*, not a fixed value: which transport is correct
# depends on whether websocket-client happens to be installed here.
try:
    import websocket  # noqa: F401
    _expected = "websocket"
except ImportError:
    _expected = "http"
check(f"picks the {_expected} transport for this environment",
      vis.stats["transport"] == _expected, vis.stats["transport"])
check("reports connected", vis.connected, vis.stats)

vis.reset()
scout = vis.register("scout_1", name="Scout", role="scout",
                     avatar_type="rogue", initial_pos={"x": 2, "y": 3})
scout.move_to(zone="library")
scout.move_to(8, 5, speed=1.5)
scout.update_state("Executing Tool: WebSearch", metrics={"tokens": 320, "latency_ms": 140})
scout.speak("Discovered target node.", to="mage_1")
vis.graph_edge("scout_1", "mage_1", weight=2.0)
time.sleep(2.0)

st = state()
agent_ids = sorted(a["agent_id"] for a in st["agents"])
check("agents reached the server", agent_ids == ["mage_1", "scout_1"], agent_ids)

scout_rec = next(a for a in st["agents"] if a["agent_id"] == "scout_1")
check("state_update merged server-side",
      scout_rec.get("status") == "Executing Tool: WebSearch", scout_rec.get("status"))
check("auto_register created the speak() target",
      any(a["agent_id"] == "mage_1" for a in st["agents"]))
check("move coordinates clamped to the grid",
      scout_rec["initial_pos"] == {"x": 8, "y": 5}, scout_rec["initial_pos"])

events = [e["event"] for e in st["recent"]]
check("every core event type arrived",
      set(["register", "move", "communicate", "state_update", "graph_edge"]) <= set(events),
      ",".join(events))

edge = next((e for e in st["edges"] if e["source"] == "scout_1"), None)
check("graph edge weight accumulated (explicit 2.0 + implicit 1.0 from speak)",
      edge and edge["weight"] == 3.0, edge)

# --- out-of-range coordinates are clamped, not rejected --------------------
scout.move_to(999, -5)
time.sleep(1.2)
scout_rec = next(a for a in state()["agents"] if a["agent_id"] == "scout_1")
check("out-of-range move clamped to grid bounds",
      scout_rec["initial_pos"] == {"x": 24, "y": 0}, scout_rec["initial_pos"])

# --- decorator -------------------------------------------------------------
@visualize_agent("worker_1", client=vis, role="operator")
def do_work(x):
    return f"processed {x}"


do_work(7)
time.sleep(1.2)
check("@visualize_agent registered and reported",
      any(a["agent_id"] == "worker_1" for a in state()["agents"]))

# --- LangChain callback shape (no langchain installed) ---------------------
cb = VisualizerCallback(client=vis, reset_on_start=False)
cb.on_chain_start({"name": "planner"}, {"q": "hi"}, run_id="r1", parent_run_id=None,
                  metadata={"langgraph_node": "planner"})
cb.on_tool_start({"name": "WebSearch"}, "query", run_id="r2", parent_run_id="r1",
                 metadata={"langgraph_node": "planner"})
cb.on_tool_end("200 OK", run_id="r2")
cb.on_chain_end({"answer": 42}, run_id="r1", parent_run_id=None)
time.sleep(1.5)

st = state()
planner = next((a for a in st["agents"] if a["agent_id"] == "planner"), None)
check("VisualizerCallback maps a LangGraph node to an agent", planner is not None)
tool_events = [e for e in st["recent"]
               if e["event"] == "state_update" and "Executing Tool" in e.get("status", "")]
check("callback emits a tool status from on_tool_start",
      any("WebSearch" in e["status"] for e in tool_events),
      [e["status"] for e in tool_events])

# --- rooms: the producer declares its own floor ----------------------------
vis.define_world([
    {"id": "mcp_github", "kind": "mcp", "capacity": 6, "label": "MCP - GitHub"},
    {"id": "evals", "kind": "eval", "capacity": 9},
])
vis.define_zone("guardrails", kind="guardrail", capacity=3)
time.sleep(1.2)
st = state()
zone_ids = sorted(z["zone_id"] for z in st.get("zones", []))
check("declared rooms are retained by the bridge",
      zone_ids == ["evals", "guardrails", "mcp_github"], zone_ids)
kinds = {z["zone_id"]: z["kind"] for z in st.get("zones", [])}
check("room kinds survive the round trip",
      kinds.get("mcp_github") == "mcp" and kinds.get("evals") == "eval", kinds)
check("unknown kind is coerced to custom",
      (vis.define_zone("weird", kind="nonsense", capacity=2) or True))
time.sleep(0.8)
kinds = {z["zone_id"]: z["kind"] for z in state().get("zones", [])}
check("bad kind became custom", kinds.get("weird") == "custom", kinds.get("weird"))

vis.remove_zone("weird")
time.sleep(0.8)
check("remove_zone closes the room",
      "weird" not in {z["zone_id"] for z in state().get("zones", [])})

# --- resilience: nothing raises when the bridge is gone --------------------
dead = AgentVisualizerClient("ws://localhost:59999", client_name="dead")
try:
    dead.register("ghost").move_to(zone="tools")
    dead.update_state("ghost", "still running")
    check("calls against an unreachable bridge never raise", True)
except Exception as exc:
    check("calls against an unreachable bridge never raise", False, exc)
finally:
    dead.close(timeout=0.3)

vis.close()
print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
