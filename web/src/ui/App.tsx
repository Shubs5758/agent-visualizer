import { useCallback, useRef } from 'react';
import { PhaserGame, type PhaserGameHandle } from '../game/PhaserGame';
import type { WorldScene } from '../game/scenes/WorldScene';
import { useVisualizerSocket } from '../net/useVisualizerSocket';
import { AgentRoster } from './AgentRoster';
import { HudLayer } from './HudLayer';
import { MetricsFeed } from './MetricsFeed';
import { Toolbar } from './Toolbar';

/** Port the Vite dev server runs on; anything else is assumed to be the bridge. */
const VITE_DEV_PORT = '5173';
const FALLBACK_WS = 'ws://localhost:8765';

/**
 * Where to find the bridge.
 *
 * An explicit `VITE_VISUALIZER_WS` always wins. Otherwise we derive it from the
 * page's own origin, which is what makes the Python package work with no
 * configuration: `agent-visualizer serve` hosts this bundle and the WebSocket
 * on the same port. The Vite dev server is the one origin that is *not* the
 * bridge, so it falls back to the default port.
 */
function resolveServerUrl(): string {
  const configured = import.meta.env.VITE_VISUALIZER_WS;
  if (configured && configured !== 'auto') return configured;

  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    if (window.location.port !== VITE_DEV_PORT) {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${scheme}//${window.location.host}`;
    }
  }
  return FALLBACK_WS;
}

const SERVER_URL: string = resolveServerUrl();

export default function App() {
  const phaserRef = useRef<PhaserGameHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const socket = useVisualizerSocket(SERVER_URL);

  const focusAgent = useCallback((agentId: string) => {
    const scene = phaserRef.current?.scene as WorldScene | undefined;
    scene?.focusAgent?.(agentId);
  }, []);

  return (
    <div className="app">
      <Toolbar socket={socket} serverUrl={SERVER_URL} />

      <main className="layout">
        <AgentRoster onFocusAgent={focusAgent} />

        <section className="stage" ref={stageRef}>
          <PhaserGame ref={phaserRef} />
          <HudLayer containerRef={stageRef} />
          {/* Purely cosmetic CRT treatment; pointer-events are off. */}
          <div className="scanlines" aria-hidden />
          <div className="vignette" aria-hidden />
        </section>

        <MetricsFeed />
      </main>
    </div>
  );
}
