// End-to-end check of the ingestion bridge: WS broadcast, validation,
// snapshot replay for late viewers, HTTP ingest, and /health.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { WebSocket } from 'ws';

const PORT = Number(process.env.BRIDGE_PORT ?? 8799);
const WS_URL = `ws://localhost:${PORT}`;
const HTTP = `http://localhost:${PORT}`;

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXTERNAL = !!process.env.BRIDGE_PORT;
const server = EXTERNAL ? null : spawn(process.execPath, [`${ROOT}/server/src/index.js`], {
  env: { ...process.env, VISUALIZER_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server?.stderr.on('data', (d) => console.error('[server-err]', d.toString().trim()));

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.received = [];
    ws.on('message', (d) => ws.received.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

try {
  await sleep(900);

  // --- health ------------------------------------------------------------
  const health = await (await fetch(`${HTTP}/health`)).json();
  check('GET /health responds ok', health.ok === true, `version ${health.version}`);

  // --- viewer gets an immediate snapshot ---------------------------------
  const viewer = await open(`${WS_URL}/?role=viewer&client=test-viewer`);
  await sleep(200);
  check(
    'viewer receives snapshot on connect',
    viewer.received[0]?.event === 'snapshot',
    `first frame: ${viewer.received[0]?.event}`,
  );

  // --- producer broadcast ------------------------------------------------
  const producer = await open(`${WS_URL}/?role=producer&client=test-producer`);
  await sleep(150);
  viewer.received.length = 0;

  const outbound = [
    { event: 'register', agent_id: 'scout_1', name: 'Scout', role: 'scout', avatar_type: 'rogue', initial_pos: { x: 2, y: 3 } },
    { event: 'move', agent_id: 'scout_1', target_pos: { x: 8, y: 5 }, speed: 1.0 },
    { event: 'communicate', source_agent_id: 'scout_1', target_agent_id: 'mage_1', message: 'Discovered target node.', interaction_type: 'dialogue' },
    { event: 'state_update', agent_id: 'scout_1', status: 'Executing Tool: WebSearch', metrics: { tokens: 320, latency_ms: 140 } },
    { event: 'graph_edge', source: 'scout_1', target: 'mage_1', weight: 1.0 },
  ];
  for (const e of outbound) producer.send(JSON.stringify(e));
  await sleep(400);

  const kinds = viewer.received.map((e) => e.event);
  check(
    'all 5 core events broadcast to viewer in order',
    JSON.stringify(kinds) === JSON.stringify(outbound.map((e) => e.event)),
    kinds.join(','),
  );
  check(
    'server stamps ts and monotonic seq',
    viewer.received.every((e) => typeof e.ts === 'number') &&
      viewer.received.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq),
  );
  check(
    'producer does not receive its own echo',
    producer.received.filter((e) => e.event === 'register').length === 0,
    `producer got: ${producer.received.map((e) => e.event).join(',') || '(nothing)'}`,
  );

  // --- validation --------------------------------------------------------
  viewer.received.length = 0;
  producer.send(JSON.stringify({ event: 'move' }));                 // missing agent_id
  producer.send(JSON.stringify({ event: 'nonsense', agent_id: 'x' })); // unknown type
  producer.send(JSON.stringify({ agent_id: 'x' }));                  // no event field
  await sleep(300);
  check('malformed events are rejected, not broadcast', viewer.received.length === 0,
    `viewer saw ${viewer.received.length}`);

  // --- batch + HTTP ingest ----------------------------------------------
  viewer.received.length = 0;
  const res = await fetch(`${HTTP}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { event: 'register', agent_id: 'mage_1', name: 'Archivist', avatar_type: 'mage' },
      { event: 'state_update', agent_id: 'mage_1', status: 'Reading', metrics: { tokens: 40 } },
    ]),
  });
  const body = await res.json();
  await sleep(300);
  check('POST /ingest accepts a batch and broadcasts it',
    res.status === 202 && body.accepted === 2 && viewer.received.length === 2,
    `status ${res.status}, accepted ${body.accepted}, viewer got ${viewer.received.length}`);
  check('CORS header present on /ingest',
    res.headers.get('access-control-allow-origin') === '*');

  // --- late viewer catches up -------------------------------------------
  const late = await open(`${WS_URL}/?role=viewer&client=late`);
  await sleep(300);
  const snap = late.received[0];
  const ids = (snap?.agents ?? []).map((a) => a.agent_id).sort();
  check('late viewer snapshot contains both agents',
    JSON.stringify(ids) === JSON.stringify(['mage_1', 'scout_1']), ids.join(','));
  check('snapshot merges state_update into the agent',
    snap?.agents?.find((a) => a.agent_id === 'scout_1')?.status === 'Executing Tool: WebSearch');
  check('snapshot records move destination as the new position',
    JSON.stringify(snap?.agents?.find((a) => a.agent_id === 'scout_1')?.initial_pos) ===
      JSON.stringify({ x: 8, y: 5 }));
  check('communicate accumulated a graph edge',
    (snap?.edges ?? []).some((e) => e.source === 'scout_1' && e.target === 'mage_1' && e.weight === 2),
    JSON.stringify(snap?.edges));
  check('replay buffer is populated', (snap?.recent ?? []).length === 7,
    `${(snap?.recent ?? []).length} events`);

  // --- reset -------------------------------------------------------------
  producer.send(JSON.stringify({ event: 'reset' }));
  await sleep(300);
  const after = await (await fetch(`${HTTP}/state`)).json();
  check('reset clears agents, edges and buffer',
    after.agents.length === 0 && after.edges.length === 0 && after.recent.length === 0);

  const finalHealth = await (await fetch(`${HTTP}/health`)).json();
  check('health reports 3 live clients', finalHealth.clients === 3, `clients=${finalHealth.clients}`);

  for (const ws of [viewer, producer, late]) ws.close();
} catch (err) {
  check('test harness completed without throwing', false, String(err));
} finally {
  await sleep(200);
  server?.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
