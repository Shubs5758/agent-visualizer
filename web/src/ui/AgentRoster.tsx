import { Coins, Crosshair, Gauge, MessageSquare, Users } from 'lucide-react';
import { useVisualizerState, type AgentRecord } from '../state/agentStore';
import { ZONE_STYLES } from '../protocol/zones';

/** Room accent as CSS, for the legend chips. */
const ZONE_STYLE_HEX: Record<string, string> = Object.fromEntries(
  Object.entries(ZONE_STYLES).map(([k, s]) => [k, `#${s.accent.toString(16).padStart(6, '0')}`]),
);

function statusTone(agent: AgentRecord): string {
  if (!agent.online) return 'offline';
  if (/^error/i.test(agent.status)) return 'error';
  if (/^executing tool/i.test(agent.status)) return 'tool';
  if (/idle|complete|finished|done/i.test(agent.status)) return 'idle';
  return 'active';
}

function AgentCard({ agent, onFocus }: { agent: AgentRecord; onFocus: (id: string) => void }) {
  const tone = statusTone(agent);
  const tokens = agent.metrics.tokens;
  const latency = agent.metrics.latency_ms;

  return (
    <li className={`roster-card tone-${tone}`}>
      <button
        type="button"
        className="roster-card-main"
        onClick={() => onFocus(agent.id)}
        title="Highlight on the map"
      >
        <span className="roster-swatch" style={{ background: agent.color }} aria-hidden />
        <span className="roster-body">
          <span className="roster-head">
            <span className="roster-name">{agent.name}</span>
            <span className="roster-role">{agent.role}</span>
          </span>
          <span className="roster-status" title={agent.detail ?? agent.status}>
            <span className={`status-dot tone-${tone}`} aria-hidden />
            {agent.status}
          </span>
          <span className="roster-metrics">
            {typeof tokens === 'number' && (
              <span title="tokens">
                <Coins size={10} /> {Math.round(tokens).toLocaleString()}
              </span>
            )}
            {typeof latency === 'number' && (
              <span title="last latency">
                <Gauge size={10} /> {Math.round(latency)}ms
              </span>
            )}
            <span title="messages sent">
              <MessageSquare size={10} /> {agent.messages}
            </span>
          </span>
        </span>
        <Crosshair size={12} className="roster-focus-icon" />
      </button>
    </li>
  );
}

export function AgentRoster({ onFocusAgent }: { onFocusAgent: (id: string) => void }) {
  const { agents, edges, zones } = useVisualizerState();
  const online = agents.filter((a) => a.online).length;

  return (
    <aside className="panel panel-left">
      <header className="panel-header">
        <Users size={13} />
        <h2>Agent Roster</h2>
        <span className="panel-count">
          {online}/{agents.length}
        </span>
      </header>

      {agents.length === 0 ? (
        <div className="panel-empty">
          <p>No agents connected.</p>
          <p className="dim">
            Run <code>python sdk/python/examples/basic_demo.py</code>, or press{' '}
            <strong>Test UI</strong> to simulate a run.
          </p>
        </div>
      ) : (
        <ul className="roster-list">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onFocus={onFocusAgent} />
          ))}
        </ul>
      )}

      <section className="panel-section">
        <h3>Collaboration graph</h3>
        {edges.length === 0 ? (
          <p className="dim small">No edges yet.</p>
        ) : (
          <ul className="edge-list">
            {edges
              .slice()
              .sort((a, b) => b.weight - a.weight)
              .slice(0, 8)
              .map((edge) => (
                <li key={`${edge.source}->${edge.target}`}>
                  <span className="edge-pair">
                    {edge.source} → {edge.target}
                  </span>
                  <span className="edge-weight">{edge.weight.toFixed(1)}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="panel-section">
        <h3>Rooms ({zones.length})</h3>
        {zones.length === 0 ? (
          <p className="dim small">Default floor — declare rooms with `zone` events.</p>
        ) : (
          <ul className="zone-list">
            {zones.map((zone) => (
              <li key={zone.id}>
                <span
                  className="zone-chip"
                  style={{ borderColor: zone.color ?? ZONE_STYLE_HEX[zone.kind] ?? '#94a3b8' }}
                >
                  {zone.id}
                </span>
                <span className="dim small">
                  {zone.kind} · {zone.capacity} seats
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
