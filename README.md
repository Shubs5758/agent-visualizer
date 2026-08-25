# 2D Retro AI Agent Visualizer

Watch your multi-agent workflow **as a top-down pixel-art game**. Agents spawn on
a grid, walk to the Library to read memory, march to the Tool Forge to run tools,
and cross the map to talk to each other — all driven by events streamed from your
existing Python or TypeScript agent code.

Two lines of integration, no changes to your agent logic:

```python
from agent_visualizer import VisualizerCallback

vis = VisualizerCallback()   # defaults to ws://localhost:8765
graph.invoke(state, config={"callbacks": [vis]})   # LangGraph / LangChain
```

---

## Quick start — pip only (no Node required)

The dashboard is bundled inside the Python wheel, so one install gets you
everything:

> **Not published to PyPI yet** — install from this repo:

```bash
pip install "agent-visualizer[server] @ git+https://github.com/Shubs5758/agent-visualizer.git#subdirectory=sdk/python"
agent-visualizer serve          # bridge + dashboard on http://localhost:8765
```

From a clone, `pip install "sdk/python[server]"` (add `-e` for an editable install).

Then, in a second terminal:

```bash
agent-visualizer demo           # scripted three-agent run
```

That is the whole setup for consumers. See [sdk/python/README.md](sdk/python/README.md)
for the package docs.

## Quick start — from this repo (for working on the dashboard)

```bash
npm install          # web app + Node bridge (workspaces)
npm run dev          # bridge on :8765 + Vite dev server on :5173
```

Open <http://localhost:5173> and press **Test UI** — a four-agent scenario plays
out with no backend running at all.

> **Node 20.19+ or 22+ recommended.** The project is pinned to Vite 6 so it also
> builds on Node 18/21, where Vite 7+ native bindings fail to install.

### Two bridges, one protocol

There are two interchangeable implementations of the bridge, and both pass the
same conformance suite:

| Bridge | Used by | Why it exists |
| --- | --- | --- |
| `agent_visualizer.bridge` (Python, aiohttp) | `pip install` users | Removes the Node dependency entirely and serves the bundled dashboard |
| [server/src/index.js](server/src/index.js) (Node, `ws`) | `npm run dev` | The dashboard dev loop already needs Node; keeps the JS workflow self-contained |

Pick either — producers and viewers cannot tell them apart. If you only care
about the Python path, `server/` can be deleted.

---

## Architecture

```
   your agent code                  bridge                    browser
┌────────────────────┐      ┌───────────────────┐     ┌────────────────────────┐
│ LangGraph / CrewAI │      │  Node + ws        │     │ React dashboard        │
│ AutoGen / anything │─ws──▶│  :8765            │─ws─▶│  ├ roster (left)       │
│                    │      │  · validation     │     │  ├ Phaser 3 canvas     │
│ agent_visualizer   │─http▶│  · replay buffer  │     │  │   └ HUD overlays    │
└────────────────────┘      │  · fan-out        │     │  └ metrics feed (right)│
                            └───────────────────┘     └────────────────────────┘
```

Everything in the browser flows through **one EventBus**, so the WebSocket feed
and the built-in mock simulator are indistinguishable to the scene — if the mock
looks right, a real backend will too.

### Layout

| Path                              | What it is                                                   |
| --------------------------------- | ------------------------------------------------------------ |
| `protocol/PROTOCOL.md`            | The event contract — start here                              |
| `protocol/agent-events.schema.json` | JSON Schema (draft 2020-12) for validation/codegen          |
| `server/src/index.js`             | Node bridge (the Python one lives in the package above)      |
| `sdk/python/src/agent_visualizer/` | The installable package: client, callback, bridge, CLI      |
| `sdk/python/examples/`            | Runnable demos (plain Python, and LangGraph)                 |
| `web/src/protocol/`               | TS types + world geometry (single source of truth)           |
| `web/src/game/`                   | Phaser scene, procedural sprites, A\* pathfinding, EventBus  |
| `web/src/net/`                    | WebSocket client, event dispatch, mock simulator             |
| `web/src/state/agentStore.ts`     | Dashboard state (external store + `useSyncExternalStore`)    |
| `web/src/ui/`                     | Toolbar, roster, feed, HUD overlays                          |

---

## The protocol

Five core events, fully documented in [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md):

| Event          | Effect on screen                                                  |
| -------------- | ------------------------------------------------------------------ |
| `register`     | Spawns a pixel-art sprite                                          |
| `move`         | A\* pathfinds and walks the sprite (`target_pos` or `target_zone`)  |
| `communicate`  | Source walks to the target, then a speech bubble + beam appear      |
| `state_update` | Status tag above the sprite, plus tokens/latency in the feed        |
| `graph_edge`   | Draws a weighted collaboration link                                 |

Anything that can send JSON can drive it:

```bash
curl -X POST http://localhost:8765/ingest -H 'Content-Type: application/json' \
  -d '{"event":"register","agent_id":"scout_1","name":"Scout","avatar_type":"rogue"}'
```

---

## Python SDK

### Direct control

```python
from agent_visualizer import AgentVisualizerClient

vis = AgentVisualizerClient()

scout = vis.register("scout_1", name="Scout", role="scout", avatar_type="rogue")
scout.move_to(zone="library")
scout.update_state("Executing Tool: WebSearch", metrics={"tokens": 320, "latency_ms": 140})
scout.speak("Found the target node.", to="mage_1")
```

### LangChain / LangGraph — automatic

`VisualizerCallback` reads LangGraph's `langgraph_node` metadata, so **each graph
node becomes an agent sprite** with no code inside your nodes:

```python
vis = VisualizerCallback()   # defaults to ws://localhost:8765
app.invoke(state, config={"callbacks": [vis]})
```

It walks the sprite to the Tool Forge on `on_tool_start`, to the Library on
`on_retriever_start`, bubbles LLM output, and accumulates token/latency metrics.

### Any plain function

```python
from agent_visualizer import visualize_agent

@visualize_agent("scout_1", role="scout", avatar_type="rogue")
def scout(query: str) -> str:
    ...
```

### Design guarantees

- **Never breaks your program.** Every method is fire-and-forget; transport
  errors are swallowed and logged at DEBUG.
- **Never blocks.** A daemon thread owns the socket; your calls just enqueue.
- **Zero required dependencies.** With `websocket-client` installed it uses a
  WebSocket; otherwise it falls back to batched HTTP POST using only the stdlib.
- **Survives restarts.** On reconnect it re-announces every agent it registered,
  so the scene repopulates even if the bridge was restarted mid-run.

---

## Dashboard

- **Left — Agent Roster.** Live agents, role, status, tokens/latency, message
  counts, the collaboration graph, and the zone legend. Click an agent to flash
  it on the map.
- **Centre — the grid.** Phaser 3, 25×18 tiles, five interaction zones. Sprites
  are generated at runtime from pixel maps, so there are **no image assets** to
  load or keep in sync.
- **Right — Live Feed.** Scrolling log of thoughts, tool calls and messages, with
  filters, follow-mode, and aggregate stat tiles.
- **Toolbar.** `Test UI` (mock run), `Loop`, `Pause`, `JSON` (hand-write an event
  and dispatch it), `Clear`, `Reconnect`.

### Configuration

| Variable              | Where    | Default                | Purpose                    |
| --------------------- | -------- | ---------------------- | -------------------------- |
| `VITE_VISUALIZER_WS`  | `web/`   | `ws://localhost:8765`  | Bridge URL the browser uses |
| `VISUALIZER_PORT`     | `server/`| `8765`                 | Listen port                 |
| `VISUALIZER_HOST`     | `server/`| all interfaces         | Bind address                |
| `VISUALIZER_BUFFER`   | `server/`| `500`                  | Replay buffer size          |
| `VISUALIZER_CORS_ORIGIN` | `server/` | `*`                 | CORS origin for HTTP ingest |

---

## Scripts

| Command             | Does                                          |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Bridge + dashboard together                   |
| `npm run server`    | Bridge only                                   |
| `npm run web`       | Dashboard only                                |
| `npm run build`     | Type-check and build the dashboard            |
| `npm run demo`      | Runs the Python demo                          |

---

## Notes on a few decisions

- **Agents do not block each other's pathfinding.** Treating them as obstacles
  deadlocks the moment two agents swap zones; a brief sprite overlap reads far
  better than a stuck agent.
- **HUD positions bypass React state.** Sprite coordinates arrive every frame and
  are written straight to `style.transform` via refs. Re-rendering the tree at
  60 fps would drop frames with only a handful of agents.
- **The bridge binds dual-stack.** `localhost` resolves to `::1` first on Windows
  and modern Linux; binding IPv4-only makes every client burn ~2 s on a failed
  IPv6 connect first, which looks exactly like a flaky server.
- **Plain CSS, not Tailwind.** The UI is one cohesive retro theme in ~700 lines;
  a utility framework would have cost more than it saved. `lucide-react` is used
  for icons as specified.
