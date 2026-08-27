/**
 * Mock agent traffic for the "Test UI" button.
 *
 * Emits real protocol JSON through `dispatchPayload`, the same entry point the
 * WebSocket uses — so this exercises validation, the store, and the scene
 * exactly as a live backend would. Nothing here is scene-aware.
 *
 * The run declares its own floor: registry, vector store, an MCP server, an
 * eval harness, guardrails. Pressing "Test UI" is therefore also a demo of
 * dynamic rooms, not just of agents walking around a fixed map.
 */

import type { AgentEvent } from '../protocol/events';
import { dispatchPayload } from './dispatch';

interface Beat {
  /** Milliseconds from the start of the scenario. */
  at: number;
  event: AgentEvent;
}

const ROOMS = [
  { zone_id: 'gateway', label: 'GATEWAY', kind: 'gateway', capacity: 4 },
  { zone_id: 'registry', label: 'AGENT REGISTRY', kind: 'registry', capacity: 4 },
  { zone_id: 'vectors', label: 'VECTOR STORE', kind: 'memory', capacity: 6 },
  { zone_id: 'mcp_github', label: 'MCP GITHUB', kind: 'mcp', capacity: 4 },
  { zone_id: 'llm', label: 'MODEL CALLS', kind: 'llm', capacity: 6 },
  { zone_id: 'evals', label: 'EVAL HARNESS', kind: 'eval', capacity: 6 },
  { zone_id: 'guardrails', label: 'GUARDRAILS', kind: 'guardrail', capacity: 3 },
  { zone_id: 'output', label: 'ARTIFACTS', kind: 'output', capacity: 4 },
] as const;

const AGENTS = [
  { id: 'planner_1', name: 'Planner', role: 'planner', avatar: 'mage' },
  { id: 'scout_1', name: 'Retriever', role: 'researcher', avatar: 'rogue' },
  { id: 'smith_1', name: 'Tool Runner', role: 'operator', avatar: 'artificer' },
  { id: 'judge_1', name: 'Evaluator', role: 'critic', avatar: 'knight' },
] as const;

const MCP_TOOLS = ['list_issues', 'get_file_contents', 'create_pull_request'];

function buildScenario(): Beat[] {
  const beats: Beat[] = [];
  let t = 0;
  const push = (delay: number, event: AgentEvent) => {
    t += delay;
    beats.push({ at: t, event });
  };

  push(0, { event: 'reset' });

  // Rooms first — they have to exist before anyone can be sent into one.
  for (const room of ROOMS) {
    push(60, { event: 'zone', ...room });
  }

  for (const agent of AGENTS) {
    push(200, {
      event: 'register',
      agent_id: agent.id,
      name: agent.name,
      role: agent.role,
      avatar_type: agent.avatar,
    });
  }

  push(600, {
    event: 'communicate',
    source_agent_id: 'planner_1',
    message: 'Objective received. Checking the registry.',
    interaction_type: 'broadcast',
  });

  // --- registry lookup --------------------------------------------------
  push(700, { event: 'move', agent_id: 'planner_1', target_zone: 'registry' });
  push(300, {
    event: 'state_update',
    agent_id: 'planner_1',
    status: 'Resolving agent registry',
    detail: 'registry.list(capabilities=["search", "code"])',
    metrics: { tokens: 180, latency_ms: 90 },
  });
  push(2200, {
    event: 'communicate',
    source_agent_id: 'planner_1',
    target_agent_id: 'scout_1',
    message: 'Retriever, pull context from the vector store.',
    interaction_type: 'handoff',
  });

  // --- retrieval --------------------------------------------------------
  push(2400, { event: 'move', agent_id: 'scout_1', target_zone: 'vectors' });
  push(300, {
    event: 'state_update',
    agent_id: 'scout_1',
    status: 'Searching memory',
    detail: 'vector_store.similarity_search(k=8)',
    metrics: { tokens: 420, latency_ms: 260, documents: 8 },
  });
  push(2400, {
    event: 'communicate',
    source_agent_id: 'scout_1',
    target_agent_id: 'smith_1',
    message: '8 documents retrieved. Over to you.',
    interaction_type: 'handoff',
  });

  // --- MCP server -------------------------------------------------------
  push(2400, { event: 'move', agent_id: 'smith_1', target_zone: 'mcp_github' });
  let tokens = 600;
  MCP_TOOLS.forEach((tool) => {
    tokens += 190;
    push(400, {
      event: 'state_update',
      agent_id: 'smith_1',
      status: `Executing Tool: ${tool}`,
      detail: `mcp://github/${tool}`,
      metrics: { tokens, latency_ms: 140 },
    });
    push(1300, {
      event: 'communicate',
      source_agent_id: 'smith_1',
      message: `${tool} returned 200 OK`,
      interaction_type: 'response',
    });
  });

  // --- model call -------------------------------------------------------
  push(1600, { event: 'move', agent_id: 'planner_1', target_zone: 'llm' });
  push(300, {
    event: 'state_update',
    agent_id: 'planner_1',
    status: 'Thinking',
    detail: 'Drafting the patch summary from 8 documents and 3 tool results.',
    metrics: { tokens: 2140, latency_ms: 1830 },
  });
  push(2400, {
    event: 'communicate',
    source_agent_id: 'planner_1',
    target_agent_id: 'judge_1',
    message: 'Draft ready. Grade it.',
    interaction_type: 'request',
  });

  // --- evaluation: four agents in one room, i.e. the crowding case --------
  push(2200, { event: 'move', agent_id: 'judge_1', target_zone: 'evals' });
  push(0, { event: 'move', agent_id: 'scout_1', target_zone: 'evals' });
  push(0, { event: 'move', agent_id: 'smith_1', target_zone: 'evals' });
  push(0, { event: 'move', agent_id: 'planner_1', target_zone: 'evals' });
  push(400, {
    event: 'state_update',
    agent_id: 'judge_1',
    status: 'Scoring against rubric',
    detail: 'faithfulness 0.94, relevance 0.88, 12 criteria',
    metrics: { tokens: 980, latency_ms: 640 },
  });
  push(2400, {
    event: 'communicate',
    source_agent_id: 'judge_1',
    target_agent_id: 'planner_1',
    message: '11 of 12 criteria pass. One revision needed.',
    interaction_type: 'response',
  });

  // --- guardrails -------------------------------------------------------
  push(2400, { event: 'move', agent_id: 'judge_1', target_zone: 'guardrails' });
  push(300, {
    event: 'state_update',
    agent_id: 'judge_1',
    status: 'Policy check',
    detail: 'pii clean, secrets clean, licence ok',
    metrics: { tokens: 140, latency_ms: 70 },
  });

  push(200, {
    event: 'graph_edge', source: 'planner_1', target: 'scout_1', weight: 2, label: 'retrieve',
  });
  push(0, {
    event: 'graph_edge', source: 'scout_1', target: 'smith_1', weight: 2, label: 'tools',
  });
  push(0, {
    event: 'graph_edge', source: 'smith_1', target: 'judge_1', weight: 1.5, label: 'grade',
  });

  // --- deliver ----------------------------------------------------------
  push(2200, { event: 'move', agent_id: 'planner_1', target_zone: 'output', speed: 1.2 });
  push(400, {
    event: 'state_update',
    agent_id: 'planner_1',
    status: 'Complete',
    detail: 'PR #482 opened with the revised patch.',
    metrics: { tokens: 3980, latency_ms: 118, cost_usd: 0.064 },
  });
  push(2000, {
    event: 'communicate',
    source_agent_id: 'planner_1',
    message: 'Artifact stored. PR #482 is open.',
    interaction_type: 'broadcast',
  });
  for (const agent of AGENTS) {
    push(200, { event: 'state_update', agent_id: agent.id, status: 'Idle' });
  }

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
