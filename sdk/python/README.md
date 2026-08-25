# agent-visualizer

Watch your multi-agent AI workflow as a **2D retro pixel-art game**. Agents spawn
on a grid, walk to the Library to read memory, march to the Tool Forge to run
tools, and cross the map to talk to each other — driven by events streamed from
your existing agent code.

Works with **LangGraph**, **LangChain**, **deepagents**, or any Python at all.

> **Not on PyPI yet.** Install from GitHub until the first release is published:

```bash
pip install "agent-visualizer[server] @ git+https://github.com/Shubs5758/agent-visualizer.git#subdirectory=sdk/python"
agent-visualizer serve
```

That opens the dashboard at <http://localhost:8765>. No Node, no npm, no separate
front end — the built UI ships inside the wheel.

Try it with no code of your own:

```bash
agent-visualizer demo      # in a second terminal
```

---

## Integrating

### LangGraph / LangChain — one callback

Each LangGraph **node** becomes a sprite automatically; your nodes stay clean.

```python
from agent_visualizer import VisualizerCallback

vis = VisualizerCallback()
graph.invoke(state, config={"callbacks": [vis]})
```

It walks the sprite to the Tool Forge on `on_tool_start`, to the Library on
`on_retriever_start`, bubbles LLM output, and accumulates token/latency metrics.

To control the name a sprite gets — useful with `create_react_agent`, whose
internal nodes are called `agent` and `tools` — set it in metadata:

```python
researcher = create_react_agent(model, tools).with_config(
    {"metadata": {"agent_id": "researcher"}}
)
```

### Any plain function

```python
from agent_visualizer import visualize_agent

@visualize_agent("scout_1", role="scout", avatar_type="rogue")
def scout(query: str) -> str:
    ...
```

### Direct control

```python
from agent_visualizer import AgentVisualizerClient

vis = AgentVisualizerClient()

scout = vis.register("scout_1", name="Scout", role="scout", avatar_type="rogue")
scout.move_to(zone="library")
scout.update_state("Executing Tool: WebSearch", metrics={"tokens": 320, "latency_ms": 140})
scout.speak("Found the target node.", to="mage_1")
```

Zones: `gateway`, `library`, `tools`, `council`, `vault`.
Avatars: `knight`, `artificer`, `rogue`, `cleric`, `bard`, `ranger`, `mage`, `druid`.

---

## Install options

Until the package is on PyPI, replace `agent-visualizer` below with the GitHub
URL form: `"agent-visualizer[EXTRA] @ git+https://github.com/Shubs5758/agent-visualizer.git#subdirectory=sdk/python"`.

| Extra | Gets you |
| --- | --- |
| *(none)* | The client only — **zero dependencies** |
| `[ws]` | + WebSocket transport (lower latency) |
| `[server]` | + the bridge and the bundled dashboard |
| `[all]` | Everything |

Working on the code itself? `pip install -e "sdk/python[all]"` from the repo root.

The client works with **no dependencies at all**: without `websocket-client` it
falls back to batched HTTP POST using only the standard library. Install the
`ws` extra when you want the persistent socket.

---

## CLI

| Command | Does |
| --- | --- |
| `agent-visualizer serve` | Bridge + dashboard on `:8765` (opens a browser) |
| `agent-visualizer serve --port 9000` | Different port |
| `agent-visualizer serve --no-dashboard` | API only |
| `agent-visualizer demo` | Play a scripted three-agent scenario |
| `agent-visualizer info` | Version, extras, whether the UI is bundled |

---

## Design guarantees

- **Never breaks your program.** Every method is fire-and-forget; transport
  errors are swallowed and logged at DEBUG. If the bridge is not running, your
  agent code still runs at full speed.
- **Never blocks.** A daemon thread owns the socket; your calls only enqueue.
- **Survives restarts.** On reconnect the client re-announces every agent it
  registered, so the scene repopulates even if the bridge restarted mid-run.
- **Disable in production** with `AgentVisualizerClient(..., enabled=False)` —
  every method becomes a no-op.

For a long-running service, create **one** client at startup and share it;
`VisualizerCallback(server_url=...)` builds its own client and its own thread,
so constructing one per request leaks threads:

```python
client = AgentVisualizerClient()                      # once, at startup

def handle(state):
    vis = VisualizerCallback(client=client, reset_on_start=False)
    return graph.invoke(state, config={"callbacks": [vis]})
```

---

## Protocol

Any language that can send JSON can drive the visualizer:

```bash
curl -X POST http://localhost:8765/ingest -H 'Content-Type: application/json' \
  -d '{"event":"register","agent_id":"scout_1","name":"Scout","avatar_type":"rogue"}'
```

Five core events — `register`, `move`, `communicate`, `state_update`,
`graph_edge`. The full specification, including the JSON Schema, is in
`protocol/PROTOCOL.md` in the repository.

## License

MIT
