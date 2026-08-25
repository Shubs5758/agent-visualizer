# Agent Visualizer Event Protocol v1

A framework-agnostic JSON event protocol for streaming AI-agent activity into the
2D Retro Agent Visualizer. Anything that can emit JSON over a WebSocket (or an
HTTP POST) can drive the visualization — LangGraph, CrewAI, AutoGen, a bash
script, a Rust service.

- **Transport:** WebSocket `ws://localhost:8765` (default), or `POST http://localhost:8765/ingest`
- **Encoding:** UTF-8 JSON, one object per WebSocket frame (or a JSON array to batch)
- **Discriminator:** the `event` field

---

## 1. Envelope

Every event shares this envelope. Only `event` is required; the server fills in
the rest when they are missing.

| Field    | Type     | Required | Notes                                                          |
| -------- | -------- | -------- | -------------------------------------------------------------- |
| `event`  | `string` | yes      | Event type discriminator (see below)                            |
| `ts`     | `number` | no       | Unix epoch **milliseconds**. Server stamps it if absent          |
| `run_id` | `string` | no       | Groups events from one workflow execution                        |
| `seq`    | `number` | no       | Monotonic sequence assigned by the server on ingest              |

Unknown fields are preserved and forwarded. Unknown `event` values are dropped by
the server with a warning, so adding new event types is backwards-compatible.

---

## 2. Core events

### 2.1 `register` — REGISTER_AGENT

Creates (or re-creates) an agent sprite on the grid. Sending `register` twice for
the same `agent_id` updates the existing agent instead of duplicating it.

```json
{
  "event": "register",
  "agent_id": "scout_1",
  "name": "Scout",
  "role": "scout",
  "avatar_type": "rogue",
  "initial_pos": { "x": 2, "y": 3 }
}
```

| Field         | Type            | Required | Notes                                                                                             |
| ------------- | --------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `agent_id`    | `string`        | yes      | Stable unique id                                                                                   |
| `name`        | `string`        | no       | Display name. Defaults to `agent_id`                                                               |
| `role`        | `string`        | no       | Free text, shown in the roster (`scout`, `planner`, `critic`, …)                                   |
| `avatar_type` | `string`        | no       | One of `knight`, `artificer`, `rogue`, `cleric`, `bard`, `ranger`, `mage`, `druid`. Unknown values hash to one of these deterministically |
| `initial_pos` | `{x,y}`         | no       | Grid tile coords. Defaults to a free tile in the `gateway` zone                                    |
| `color`       | `string`        | no       | `#rrggbb` override for the sprite tint and roster swatch                                           |

### 2.2 `move` — AGENT_MOVE

Walks the agent to a destination. The scene runs A\* over the grid and animates
the sprite tile-by-tile; it does **not** teleport.

```json
{
  "event": "move",
  "agent_id": "scout_1",
  "target_pos": { "x": 8, "y": 5 },
  "speed": 1.0
}
```

| Field         | Type      | Required | Notes                                                                        |
| ------------- | --------- | -------- | ---------------------------------------------------------------------------- |
| `agent_id`    | `string`  | yes      |                                                                              |
| `target_pos`  | `{x,y}`   | one of\* | Destination tile                                                             |
| `target_zone` | `string`  | one of\* | **Extension:** zone id (`gateway`, `library`, `tools`, `council`, `vault`). The scene picks a free tile inside it |
| `speed`       | `number`  | no       | Multiplier, default `1.0`. `2.0` is twice as fast                            |

\* Provide `target_pos` **or** `target_zone`. If both are present, `target_pos` wins.
If the target tile is blocked or unreachable, the nearest reachable tile is used.

### 2.3 `communicate` — AGENT_COMMUNICATE

The source agent walks to a tile adjacent to the target agent, then shows a
speech bubble. Also implicitly creates a graph edge between the two agents.

```json
{
  "event": "communicate",
  "source_agent_id": "scout_1",
  "target_agent_id": "mage_1",
  "message": "Discovered target node.",
  "interaction_type": "dialogue"
}
```

| Field              | Type     | Required | Notes                                                                          |
| ------------------ | -------- | -------- | ------------------------------------------------------------------------------ |
| `source_agent_id`  | `string` | yes      |                                                                                |
| `target_agent_id`  | `string` | no       | Omit (or `null`) for a broadcast — the bubble shows without anyone walking      |
| `message`          | `string` | yes      | Bubble text. Long text is clamped in the bubble but kept in full in the feed    |
| `interaction_type` | `string` | no       | `dialogue` \| `handoff` \| `request` \| `response` \| `broadcast`. Default `dialogue`. Controls bubble color and the beam effect |

### 2.4 `state_update` — AGENT_STATE_UPDATE

Updates the status tag floating above the sprite and the roster entry.

```json
{
  "event": "state_update",
  "agent_id": "scout_1",
  "status": "Executing Tool: WebSearch",
  "metrics": { "tokens": 320, "latency_ms": 140 }
}
```

| Field      | Type     | Required | Notes                                                                     |
| ---------- | -------- | -------- | ------------------------------------------------------------------------- |
| `agent_id` | `string` | yes      |                                                                           |
| `status`   | `string` | yes      | Free text. Strings starting with `Executing Tool:` render with a tool icon |
| `detail`   | `string` | no       | **Extension:** longer text (a thought, a tool payload) shown in the feed   |
| `metrics`  | `object` | no       | Numeric map. `tokens`, `latency_ms`, `cost_usd` get first-class treatment; any other numeric key is displayed generically |

### 2.5 `graph_edge` — GRAPH_UPDATE

Declares a directed edge in the agent collaboration graph. Rendered as a glowing
link between the two sprites, with thickness driven by `weight`.

```json
{
  "event": "graph_edge",
  "source": "scout_1",
  "target": "mage_1",
  "weight": 1.0
}
```

| Field    | Type     | Required | Notes                                                             |
| -------- | -------- | -------- | ----------------------------------------------------------------- |
| `source` | `string` | yes      | agent id                                                          |
| `target` | `string` | yes      | agent id                                                          |
| `weight` | `number` | no       | Default `1.0`. Repeated edges accumulate weight                    |
| `label`  | `string` | no       | **Extension:** short edge label                                    |

---

## 3. Extension events

These are not part of the five core types but are understood by the server and
the scene.

### 3.1 `unregister`

```json
{ "event": "unregister", "agent_id": "scout_1" }
```

Removes the sprite with a fade-out. The roster keeps the agent marked `offline`.

### 3.2 `reset`

```json
{ "event": "reset" }
```

Clears all agents, edges, and the server's replay buffer. Useful at the start of
a run so a reconnecting viewer does not see stale agents.

---

## 4. Server → viewer frames

The server sends these; producers never need to.

### 4.1 `snapshot`

Sent immediately to any viewer that connects (`?role=viewer`). Lets a browser
opened halfway through a run catch up.

```json
{
  "event": "snapshot",
  "ts": 1718900000000,
  "agents": [ { "...": "last known register + state_update merged" } ],
  "edges":  [ { "source": "scout_1", "target": "mage_1", "weight": 3.0 } ],
  "recent": [ { "...": "last N raw events, oldest first" } ]
}
```

### 4.2 `server_info`

```json
{ "event": "server_info", "ts": 0, "clients": 3, "buffered": 128, "version": "1.0.0" }
```

---

## 5. World coordinates

The grid is **25 × 18 tiles**, tile size **32 px** (canvas 800 × 576). Tile
`{x: 0, y: 0}` is the top-left. Out-of-range coordinates are clamped.

Named interaction zones (usable as `target_zone`):

| Zone id   | Label             | Tiles (x, y, w, h) | Meaning                        |
| --------- | ----------------- | ------------------ | ------------------------------ |
| `gateway` | GATEWAY           | 1, 1, 4, 4         | Spawn / entry point            |
| `library` | LIBRARY · MEMORY  | 1, 12, 6, 5        | Retrieval, RAG, memory reads   |
| `tools`   | TOOL FORGE        | 18, 1, 6, 5        | Tool / function execution      |
| `council` | COUNCIL           | 10, 6, 6, 5        | Multi-agent deliberation       |
| `vault`   | VAULT · OUTPUT    | 18, 12, 6, 5       | Final answers, artifacts       |

---

## 6. Delivery semantics

- **Fan-out:** every accepted event is broadcast to all connected viewers.
- **Ordering:** preserved per producer connection; the server assigns a global `seq`.
- **Replay buffer:** the last 500 events are retained and replayed in `snapshot`.
- **Backpressure:** if a viewer's socket buffer exceeds 1 MB the server drops that
  viewer's queued frames rather than growing memory without bound.
- **Reconnection:** clients should retry with exponential backoff. The bundled
  Python SDK and the browser client both do this automatically and queue events
  while disconnected.
