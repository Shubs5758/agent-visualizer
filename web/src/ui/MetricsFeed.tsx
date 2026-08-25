import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowRightLeft,
  Coins,
  Footprints,
  Gauge,
  Info,
  MessageSquare,
  Radio,
  TriangleAlert,
  UserPlus,
  Wrench,
} from 'lucide-react';
import { useVisualizerState, type FeedEntry, type FeedKind } from '../state/agentStore';

const KIND_ICON: Record<FeedKind, typeof Info> = {
  register: UserPlus,
  move: Footprints,
  communicate: MessageSquare,
  state: Activity,
  edge: ArrowRightLeft,
  system: Info,
  error: TriangleAlert,
};

const FILTERS: { id: FeedKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'communicate', label: 'Talk' },
  { id: 'state', label: 'State' },
  { id: 'move', label: 'Move' },
  { id: 'system', label: 'Sys' },
];

function timestamp(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

function MetricChips({ entry }: { entry: FeedEntry }) {
  if (!entry.metrics) return null;
  const { tokens, latency_ms: latency, cost_usd: cost, ...rest } = entry.metrics;
  return (
    <div className="feed-metrics">
      {typeof tokens === 'number' && (
        <span>
          <Coins size={9} /> {Math.round(tokens).toLocaleString()}
        </span>
      )}
      {typeof latency === 'number' && (
        <span>
          <Gauge size={9} /> {Math.round(latency)}ms
        </span>
      )}
      {typeof cost === 'number' && <span>${cost.toFixed(4)}</span>}
      {Object.entries(rest).map(([key, value]) =>
        typeof value === 'number' ? (
          <span key={key}>
            {key}: {value}
          </span>
        ) : null,
      )}
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Info;
  label: string;
  value: string;
}) {
  return (
    <div className="stat-tile">
      <Icon size={11} />
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function MetricsFeed() {
  const { feed, totals } = useVisualizerState();
  const [filter, setFilter] = useState<FeedKind | 'all'>('all');
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => (filter === 'all' ? feed : feed.filter((entry) => entry.kind === filter)),
    [feed, filter],
  );

  // The feed is newest-first, so "following" means pinning to the top.
  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [visible, follow]);

  return (
    <aside className="panel panel-right">
      <header className="panel-header">
        <Radio size={13} />
        <h2>Live Feed</h2>
        <span className="panel-count">{feed.length}</span>
      </header>

      <div className="stat-grid">
        <StatTile icon={Activity} label="events" value={totals.events.toLocaleString()} />
        <StatTile icon={MessageSquare} label="messages" value={totals.messages.toLocaleString()} />
        <StatTile icon={Coins} label="tokens" value={Math.round(totals.tokens).toLocaleString()} />
        <StatTile icon={Wrench} label="tool calls" value={totals.toolCalls.toLocaleString()} />
        <StatTile icon={Gauge} label="avg latency" value={`${totals.avgLatencyMs}ms`} />
      </div>

      <div className="feed-controls">
        <div className="filter-row" role="tablist" aria-label="Filter feed">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={filter === option.id}
              className={filter === option.id ? 'chip active' : 'chip'}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="follow-toggle">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          follow
        </label>
      </div>

      <div
        className="feed-scroll"
        ref={scrollRef}
        onWheel={(e) => {
          // Any manual upward scroll detaches follow, like a terminal.
          if (e.deltaY > 0 && follow) setFollow(false);
        }}
      >
        {visible.length === 0 ? (
          <p className="panel-empty dim">Nothing yet.</p>
        ) : (
          <ul className="feed-list">
            {visible.map((entry) => {
              const Icon = KIND_ICON[entry.kind] ?? Info;
              return (
                <li key={entry.id} className={`feed-item kind-${entry.kind}`}>
                  <span className="feed-time">{timestamp(entry.ts)}</span>
                  <span className="feed-icon" style={{ color: entry.color }}>
                    <Icon size={12} />
                  </span>
                  <div className="feed-content">
                    <div className="feed-title">{entry.title}</div>
                    {entry.body && <div className="feed-body">{entry.body}</div>}
                    <MetricChips entry={entry} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
