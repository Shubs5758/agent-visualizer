/**
 * Agent Visualizer — ingestion & broadcast bridge.
 *
 *   producers (your agent code)  --ws/http-->  [ this server ]  --ws-->  viewers (browser)
 *
 * One port serves everything:
 *   ws://localhost:8765/            WebSocket, `?role=viewer` to also receive a snapshot
 *   POST http://localhost:8765/ingest   fire-and-forget JSON ingest (single event or array)
 *   GET  http://localhost:8765/health   liveness + counters
 *   GET  http://localhost:8765/state    current world snapshot as JSON
 *
 * See ../../protocol/PROTOCOL.md for the event schema.
 */

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const VERSION = '1.0.0';

const PORT = Number(process.env.VISUALIZER_PORT ?? 8765);
/**
 * Unset by default so Node binds every interface *dual-stack*.
 *
 * This matters more than it looks: `localhost` resolves to ::1 before
 * 127.0.0.1 on Windows and modern Linux. Binding '0.0.0.0' makes the server
 * IPv4-only, so every `localhost` client burns ~2s on a failed IPv6 connect
 * before falling back — which looks exactly like a slow, flaky bridge.
 */
const HOST = process.env.VISUALIZER_HOST;
/** How many recent events a freshly-connected viewer is allowed to replay. */
const REPLAY_BUFFER_SIZE = Number(process.env.VISUALIZER_BUFFER ?? 500);
/** Drop frames for a viewer whose socket is this far behind, rather than growing memory. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 30_000;

const PRODUCER_EVENTS = new Set([
  'register',
  'move',
  'communicate',
  'state_update',
  'graph_edge',
  'unregister',
  'reset',
]);

// ---------------------------------------------------------------------------
// World state — what a late-joining viewer needs to catch up
// ---------------------------------------------------------------------------

/** agent_id -> merged register + latest state/position */
const agents = new Map();
/** "source->target" -> edge */
const edges = new Map();
/** Ring buffer of recent raw events. */
let replay = [];
let seq = 0;
const counters = { received: 0, rejected: 0, broadcast: 0 };

function resetWorld() {
  agents.clear();
  edges.clear();
  replay = [];
}

/**
 * Fold an event into the retained world state.
 * Only the fields a viewer needs to rebuild the scene are kept.
 */
function applyToWorld(evt) {
  switch (evt.event) {
    case 'register': {
      const prev = agents.get(evt.agent_id) ?? {};
      agents.set(evt.agent_id, { ...prev, ...evt, event: 'register', online: true });
      break;
    }
    case 'move': {
      const prev = agents.get(evt.agent_id);
      if (prev && evt.target_pos) {
        // Record the destination so a reconnecting viewer spawns the agent where
        // it was heading, not where it started.
        agents.set(evt.agent_id, { ...prev, initial_pos: evt.target_pos });
      }
      break;
    }
    case 'state_update': {
      const prev = agents.get(evt.agent_id);
      if (prev) {
        agents.set(evt.agent_id, {
          ...prev,
          status: evt.status,
          metrics: { ...(prev.metrics ?? {}), ...(evt.metrics ?? {}) },
        });
      }
      break;
    }
    case 'graph_edge': {
      const key = `${evt.source}->${evt.target}`;
      const prev = edges.get(key);
      edges.set(key, {
        event: 'graph_edge',
        source: evt.source,
        target: evt.target,
        weight: (prev?.weight ?? 0) + (typeof evt.weight === 'number' ? evt.weight : 1),
        label: evt.label ?? prev?.label,
      });
      break;
    }
    case 'communicate': {
      if (evt.target_agent_id) {
        const key = `${evt.source_agent_id}->${evt.target_agent_id}`;
        const prev = edges.get(key);
        edges.set(key, {
          event: 'graph_edge',
          source: evt.source_agent_id,
          target: evt.target_agent_id,
          weight: (prev?.weight ?? 0) + 1,
        });
      }
      break;
    }
    case 'unregister': {
      const prev = agents.get(evt.agent_id);
      if (prev) agents.set(evt.agent_id, { ...prev, online: false });
      break;
    }
    case 'reset':
      resetWorld();
      break;
  }
}

function buildSnapshot() {
  return {
    event: 'snapshot',
    ts: Date.now(),
    agents: [...agents.values()],
    edges: [...edges.values()],
    recent: replay,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** @returns {{ok: true, event: object} | {ok: false, reason: string}} */
function validate(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'payload must be a JSON object' };
  }
  const type = raw.event;
  if (typeof type !== 'string' || !type) {
    return { ok: false, reason: 'missing "event" field' };
  }
  if (!PRODUCER_EVENTS.has(type)) {
    return { ok: false, reason: `unknown event type "${type}"` };
  }
  const needsAgent = ['register', 'move', 'state_update', 'unregister'];
  if (needsAgent.includes(type) && typeof raw.agent_id !== 'string') {
    return { ok: false, reason: `${type} requires agent_id` };
  }
  if (type === 'communicate' && typeof raw.source_agent_id !== 'string') {
    return { ok: false, reason: 'communicate requires source_agent_id' };
  }
  if (type === 'graph_edge' && (typeof raw.source !== 'string' || typeof raw.target !== 'string')) {
    return { ok: false, reason: 'graph_edge requires source and target' };
  }

  const event = { ...raw };
  if (typeof event.ts !== 'number') event.ts = Date.now();
  event.seq = ++seq;
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

function countViewers() {
  let n = 0;
  for (const c of clients) if (c.meta?.role === 'viewer') n++;
  return n;
}

function send(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    // Slow consumer: skip this frame instead of queueing unbounded.
    ws.meta.dropped++;
    return false;
  }
  ws.send(JSON.stringify(obj));
  return true;
}

function broadcast(event, origin) {
  for (const client of clients) {
    if (client === origin) continue; // never echo to the producer that sent it
    if (send(client, event)) counters.broadcast++;
  }
}

/** Single entry point for every accepted event, whatever transport it arrived on. */
function ingest(raw, origin, label) {
  counters.received++;
  const result = validate(raw);
  if (!result.ok) {
    counters.rejected++;
    console.warn(`[ingest] rejected from ${label}: ${result.reason}`);
    return result;
  }
  const event = result.event;
  applyToWorld(event);
  if (event.event !== 'reset') {
    replay.push(event);
    if (replay.length > REPLAY_BUFFER_SIZE) replay = replay.slice(-REPLAY_BUFFER_SIZE);
  }
  broadcast(event, origin);
  return result;
}

/** Accepts one event or an array of events. */
function ingestPayload(parsed, origin, label) {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  let accepted = 0;
  const errors = [];
  for (const item of list) {
    const r = ingest(item, origin, label);
    if (r.ok) accepted++;
    else errors.push(r.reason);
  }
  return { accepted, errors };
}

function broadcastServerInfo() {
  const info = {
    event: 'server_info',
    ts: Date.now(),
    clients: clients.size,
    viewers: countViewers(),
    buffered: replay.length,
    version: VERSION,
  };
  for (const client of clients) {
    if (client.meta?.role === 'viewer') send(client, info);
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.VISUALIZER_CORS_ORIGIN ?? '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      version: VERSION,
      uptime_s: Math.round(process.uptime()),
      clients: clients.size,
      viewers: countViewers(),
      agents: agents.size,
      edges: edges.size,
      buffered: replay.length,
      counters,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    json(res, 200, buildSnapshot());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ingest') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const { accepted, errors } = ingestPayload(parsed, null, 'http');
      json(res, errors.length && !accepted ? 400 : 202, { accepted, errors });
    } catch (err) {
      json(res, 400, { accepted: 0, errors: [String(err.message ?? err)] });
    }
    return;
  }

  json(res, 404, {
    error: 'not found',
    endpoints: ['GET /health', 'GET /state', 'POST /ingest', 'WS /'],
  });
});

// ---------------------------------------------------------------------------
// WebSocket surface
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const role = url.searchParams.get('role') === 'viewer' ? 'viewer' : 'producer';
  const name = url.searchParams.get('client') ?? 'anonymous';

  ws.meta = { role, name, dropped: 0, connectedAt: Date.now() };
  ws.isAlive = true;
  clients.add(ws);
  console.log(`[ws] + ${role} "${name}" (${clients.size} connected)`);

  if (role === 'viewer') {
    // Catch the viewer up on everything it missed.
    send(ws, buildSnapshot());
  }
  broadcastServerInfo();

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      counters.rejected++;
      send(ws, { event: 'server_error', ts: Date.now(), error: 'invalid JSON' });
      return;
    }
    // A viewer may send events too — that is how the browser's mock simulator
    // can drive other connected viewers.
    ingestPayload(parsed, ws, `${role}:${name}`);
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] - ${role} "${name}" (${clients.size} connected)`);
    broadcastServerInfo();
  });

  ws.on('error', (err) => {
    console.warn(`[ws] error from ${role} "${name}":`, err.message);
  });
});

// Drop half-open connections so `clients` cannot leak across flaky networks.
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      console.warn(`[ws] terminating unresponsive ${ws.meta?.role} "${ws.meta?.name}"`);
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

// ---------------------------------------------------------------------------

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use.\n` +
        `  Another visualizer bridge is probably still running.\n\n` +
        `  Either stop it, or start this one on a different port:\n` +
        `      VISUALIZER_PORT=8766 npm run server\n` +
        `  (and point the dashboard at it with VITE_VISUALIZER_WS=ws://localhost:8766)\n`,
    );
  } else {
    console.error(`\n  Server failed to start: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(HOST ? { port: PORT, host: HOST } : { port: PORT }, () => {
  console.log(`
  ┌─────────────────────────────────────────────────────────┐
  │  Agent Visualizer bridge v${VERSION}                         │
  ├─────────────────────────────────────────────────────────┤
  │  WebSocket   ws://localhost:${PORT}/                       │
  │  Viewers     ws://localhost:${PORT}/?role=viewer           │
  │  HTTP ingest POST http://localhost:${PORT}/ingest          │
  │  Health      GET  http://localhost:${PORT}/health          │
  └─────────────────────────────────────────────────────────┘
`);
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} — closing ${clients.size} connection(s)`);
  clearInterval(heartbeat);
  for (const ws of clients) ws.close(1001, 'server shutting down');
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
