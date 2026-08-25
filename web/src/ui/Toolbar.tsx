import { useEffect, useRef, useState } from 'react';
import {
  Braces,
  Gamepad2,
  Pause,
  Play,
  Plug,
  PlugZap,
  RefreshCw,
  Repeat,
  Trash2,
} from 'lucide-react';
import { injectRaw, startMockRun, type MockRun } from '../net/mockSimulator';
import type { SocketApi } from '../net/useVisualizerSocket';
import { agentStore, useVisualizerState } from '../state/agentStore';

const SAMPLE_PAYLOAD = `{
  "event": "register",
  "agent_id": "custom_1",
  "name": "Custom",
  "role": "tester",
  "avatar_type": "cleric",
  "initial_pos": { "x": 12, "y": 8 }
}`;

const STATUS_LABEL: Record<SocketApi['status'], string> = {
  idle: 'offline',
  connecting: 'connecting…',
  open: 'connected',
  closed: 'disconnected',
  error: 'error',
};

export function Toolbar({ socket, serverUrl }: { socket: SocketApi; serverUrl: string }) {
  const { paused, connectionDetail } = useVisualizerState();
  const [loop, setLoop] = useState(false);
  const [running, setRunning] = useState(false);
  const [showInjector, setShowInjector] = useState(false);
  const [draft, setDraft] = useState(SAMPLE_PAYLOAD);
  const [injectMessage, setInjectMessage] = useState<string | null>(null);
  const runRef = useRef<MockRun | null>(null);

  // Never leave timers running behind an unmounted toolbar.
  useEffect(() => () => runRef.current?.stop(), []);

  const stopMock = () => {
    runRef.current?.stop();
    runRef.current = null;
    setRunning(false);
  };

  const toggleMock = () => {
    if (running) {
      stopMock();
      return;
    }
    runRef.current = startMockRun({
      loop,
      // Forwarding means a second browser tab (or another viewer) sees the
      // simulated run too — handy when demoing on a projector.
      forward: socket.status === 'open' ? socket.send : undefined,
    });
    setRunning(true);
    if (!loop) {
      window.setTimeout(() => setRunning(false), runRef.current.durationMs);
    }
  };

  const handleInject = () => {
    const result = injectRaw(draft);
    setInjectMessage(result.message);
    window.setTimeout(() => setInjectMessage(null), 3500);
  };

  return (
    <header className="toolbar">
      <div className="brand">
        <Gamepad2 size={17} />
        <div>
          <h1>AGENT VISUALIZER</h1>
          <p>2D retro telemetry for multi-agent workflows</p>
        </div>
      </div>

      <div className="toolbar-actions">
        <button
          type="button"
          className={running ? 'btn btn-primary active' : 'btn btn-primary'}
          onClick={toggleMock}
          title="Dispatch mock protocol events — no backend required"
        >
          {running ? <Pause size={13} /> : <Play size={13} />}
          {running ? 'Stop Test' : 'Test UI'}
        </button>

        <button
          type="button"
          className={loop ? 'btn active' : 'btn'}
          onClick={() => setLoop((v) => !v)}
          title="Loop the mock scenario"
          aria-pressed={loop}
        >
          <Repeat size={13} />
          Loop
        </button>

        <button
          type="button"
          className={paused ? 'btn active' : 'btn'}
          onClick={() => agentStore.setPaused(!paused)}
          title="Ignore incoming events without disconnecting"
          aria-pressed={paused}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? 'Resume' : 'Pause'}
        </button>

        <button
          type="button"
          className={showInjector ? 'btn active' : 'btn'}
          onClick={() => setShowInjector((v) => !v)}
          title="Send a hand-written protocol event"
          aria-pressed={showInjector}
        >
          <Braces size={13} />
          JSON
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => agentStore.clear()}
          title="Clear the roster and feed"
        >
          <Trash2 size={13} />
          Clear
        </button>

        <button type="button" className="btn" onClick={socket.reconnect} title="Reconnect now">
          <RefreshCw size={13} />
          Reconnect
        </button>

        <div className={`conn conn-${socket.status}`} title={`${serverUrl} · ${connectionDetail}`}>
          {socket.status === 'open' ? <PlugZap size={13} /> : <Plug size={13} />}
          <span>{STATUS_LABEL[socket.status]}</span>
          {socket.attempt > 0 && socket.status !== 'open' && (
            <span className="conn-attempt">retry #{socket.attempt}</span>
          )}
        </div>
      </div>

      {showInjector && (
        <div className="injector">
          <textarea
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={7}
            aria-label="Protocol event JSON"
          />
          <div className="injector-actions">
            <button type="button" className="btn btn-primary" onClick={handleInject}>
              Dispatch
            </button>
            {injectMessage && <span className="injector-message">{injectMessage}</span>}
            <span className="dim small">
              Accepts one event or an array. See <code>protocol/PROTOCOL.md</code>.
            </span>
          </div>
        </div>
      )}
    </header>
  );
}
