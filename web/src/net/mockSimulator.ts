/**
 * Mock agent traffic for the "Test UI" button.
 *
 * Emits real protocol JSON through `dispatchPayload`, the same entry point the
 * WebSocket uses — so this exercises validation, the store, and the scene
 * exactly as a live backend would. Nothing here is scene-aware.
 */

import type { AgentEvent } from '../protocol/events';
import { dispatchPayload } from './dispatch';

interface Beat {
  /** Milliseconds from the start of the scenario. */
  at: number;
  event: AgentEvent;
}

const AGENTS = [
  { id: 'scout_1', name: 'Scout', role: 'scout', avatar: 'rogue', pos: { x: 2, y: 3 } },
  { id: 'mage_1', name: 'Archivist', role: 'researcher', avatar: 'mage', pos: { x: 3, y: 2 } },
  { id: 'smith_1', name: 'Toolsmith', role: 'operator', avatar: 'artificer', pos: { x: 2, y: 2 } },
  { id: 'critic_1', name: 'Critic', role: 'critic', avatar: 'knight', pos: { x: 4, y: 3 } },
] as const;

const TOOLS = ['WebSearch', 'PythonREPL', 'SQLQuery', 'VectorSearch', 'HttpFetch'];

function buildScenario(): Beat[] {
  const beats: Beat[] = [];
  let t = 0;
  const push = (delay: number, event: AgentEvent) => {
    t += delay;
    beats.push({ at: t, event });
  };

  push(0, { event: 'reset' });

  for (const agent of AGENTS) {
    push(220, {
      event: 'register',
      agent_id: agent.id,
      name: agent.name,
      role: agent.role,
      avatar_type: agent.avatar,
      initial_pos: agent.pos,
    });
  }

  push(700, {
    event: 'communicate',
    source_agent_id: 'scout_1',
    message: 'New objective received. Fanning out.',
    interaction_type: 'broadcast',
  });

  // --- Scout searches memory ------------------------------------------
  push(900, { event: 'move', agent_id: 'scout_1', target_zone: 'library', speed: 1.1 });
  push(200, {
    event: 'state_update',
    agent_id: 'scout_1',
    status: 'Searching memory',
    detail: 'vector_store.similarity_search("target node", k=5)',
    metrics: { tokens: 120, latency_ms: 210 },
  });
  push(2600, {
    event: 'communicate',
    source_agent_id: 'scout_1',
    target_agent_id: 'mage_1',
    message: 'Three candidate sources in the archive.',
    interaction_type: 'dialogue',
  });

  // --- Archivist reads --------------------------------------------------
  push(2800, { event: 'move', agent_id: 'mage_1', target_zone: 'library' });
  push(200, {
    event: 'state_update',
    agent_id: 'mage_1',
    status: 'Reading: vector_store',
    detail: 'Ranking 3 documents by relevance…',
    metrics: { tokens: 480, latency_ms: 340 },
  });
  push(2400, {
    event: 'communicate',
    source_agent_id: 'mage_1',
    target_agent_id: 'smith_1',
    message: 'Source #2 looks authoritative — verify it.',
    interaction_type: 'handoff',
  });

  // --- Toolsmith runs tools --------------------------------------------
  let tokens = 300;
  TOOLS.forEach((tool, i) => {
    push(i === 0 ? 2600 : 1500, {
      event: 'move',
      agent_id: 'smith_1',
      target_zone: 'tools',
      speed: 1.25,
    });
    tokens += 140 + i * 55;
    push(300, {
      event: 'state_update',
      agent_id: 'smith_1',
      status: `Executing Tool: ${tool}`,
      detail: `${tool}(query="target node", timeout=30)`,
      metrics: { tokens, latency_ms: 90 + i * 47 },
    });
    push(900, {
      event: 'communicate',
      source_agent_id: 'smith_1',
      message: `${tool} → 200 OK`,
      interaction_type: 'response',
    });
  });

  // --- Critic reviews ---------------------------------------------------
  push(1400, { event: 'move', agent_id: 'critic_1', target_zone: 'council' });
  push(300, {
    event: 'state_update',
    agent_id: 'critic_1',
    status: 'Reviewing evidence',
    detail: 'Cross-checking 5 tool results against 3 sources.',
    metrics: { tokens: 610, latency_ms: 520 },
  });
  push(2200, {
    event: 'communicate',
    source_agent_id: 'critic_1',
    target_agent_id: 'scout_1',
    message: 'Two results disagree. Re-check sector 7.',
    interaction_type: 'request',
  });

  // --- Converge ---------------------------------------------------------
  push(200, { event: 'graph_edge', source: 'scout_1', target: 'mage_1', weight: 2, label: 'findings' });
  push(0, { event: 'graph_edge', source: 'mage_1', target: 'smith_1', weight: 1.5, label: 'handoff' });
  push(0, { event: 'graph_edge', source: 'smith_1', target: 'critic_1', weight: 1, label: 'results' });

  push(2600, { event: 'move', agent_id: 'scout_1', target_zone: 'council' });
  push(0, { event: 'move', agent_id: 'mage_1', target_zone: 'council' });
  push(0, { event: 'move', agent_id: 'smith_1', target_zone: 'council' });

  push(2800, {
    event: 'communicate',
    source_agent_id: 'mage_1',
    target_agent_id: 'critic_1',
    message: 'Sector 7 confirmed. Consensus reached.',
    interaction_type: 'response',
  });

  // --- Deliver ----------------------------------------------------------
  push(2600, { event: 'move', agent_id: 'mage_1', target_zone: 'vault', speed: 1.2 });
  push(400, {
    event: 'state_update',
    agent_id: 'mage_1',
    status: 'Complete',
    detail: 'Answer written to the vault.',
    metrics: { tokens: 1240, latency_ms: 118, cost_usd: 0.021 },
  });
  push(2200, {
    event: 'communicate',
    source_agent_id: 'mage_1',
    message: 'Artifact stored. Target node: sector 7.',
    interaction_type: 'broadcast',
  });
  push(1200, { event: 'state_update', agent_id: 'scout_1', status: 'Idle' });
  push(0, { event: 'state_update', agent_id: 'smith_1', status: 'Idle' });
  push(0, { event: 'state_update', agent_id: 'critic_1', status: 'Idle' });

  return beats;
}

export interface MockRun {
  stop: () => void;
  durationMs: number;
}

/**
 * Play the scripted scenario.
 *
 * @param loop     restart automatically when the scenario ends
 * @param forward  also publish each event to the bridge, so other connected
 *                 dashboards see the mock run too
 */
export function startMockRun(options: {
  loop?: boolean;
  forward?: (payload: unknown) => boolean;
} = {}): MockRun {
  const beats = buildScenario();
  const duration = beats.length ? beats[beats.length - 1].at + 1500 : 0;
  const timers: number[] = [];
  let stopped = false;

  const schedule = (offset: number) => {
    for (const beat of beats) {
      timers.push(
        window.setTimeout(() => {
          if (stopped) return;
          dispatchPayload(beat.event);
          options.forward?.(beat.event);
        }, offset + beat.at),
      );
    }
    if (options.loop) {
      timers.push(
        window.setTimeout(() => {
          if (!stopped) schedule(0);
        }, offset + duration),
      );
    }
  };

  schedule(0);

  return {
    durationMs: duration,
    stop: () => {
      stopped = true;
      for (const id of timers) window.clearTimeout(id);
      timers.length = 0;
    },
  };
}

/** Fire a single hand-written payload — used by the JSON injector panel. */
export function injectRaw(json: string): { ok: boolean; message: string } {
  try {
    const parsed = JSON.parse(json);
    const accepted = dispatchPayload(parsed);
    return accepted > 0
      ? { ok: true, message: `dispatched ${accepted} event(s)` }
      : { ok: false, message: 'event rejected — see the feed for the reason' };
  } catch (err) {
    return { ok: false, message: `invalid JSON: ${(err as Error).message}` };
  }
}
