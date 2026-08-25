import { useCallback, useEffect, useRef, useState } from 'react';
import { agentStore } from '../state/agentStore';
import { dispatchPayload } from './dispatch';

export interface SocketApi {
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  attempt: number;
  /** Abandon any backoff and retry immediately. */
  reconnect: () => void;
  /** Publish an event back through the bridge (used by the mock simulator). */
  send: (payload: unknown) => boolean;
}

const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 700;

/**
 * WebSocket client for the ingestion bridge.
 *
 * Reconnects with exponential backoff plus jitter, and identifies itself as a
 * viewer so the server replies with a snapshot — which is what lets you open
 * the dashboard halfway through a run and still see every agent.
 */
export function useVisualizerSocket(url: string, enabled = true): SocketApi {
  const [status, setStatus] = useState<SocketApi['status']>('idle');
  const [attempt, setAttempt] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const disposedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const connect = useCallback(() => {
    if (disposedRef.current || !enabled) return;
    clearTimer();

    // Drop any previous socket without letting its onclose schedule a retry.
    const previous = socketRef.current;
    if (previous) {
      previous.onopen = previous.onclose = previous.onerror = previous.onmessage = null;
      previous.close();
    }

    setStatus('connecting');
    agentStore.setConnection('connecting', url);

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${url}${url.includes('?') ? '&' : '?'}role=viewer&client=dashboard`);
    } catch (err) {
      setStatus('error');
      agentStore.setConnection('error', String(err));
      scheduleRetry();
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      if (disposedRef.current) return;
      attemptRef.current = 0;
      setAttempt(0);
      setStatus('open');
      agentStore.setConnection('open', url);
    };

    socket.onmessage = (message) => {
      try {
        dispatchPayload(JSON.parse(message.data));
      } catch {
        agentStore.reportProtocolError('invalid JSON frame', String(message.data).slice(0, 200));
      }
    };

    socket.onerror = () => {
      if (disposedRef.current) return;
      setStatus('error');
    };

    socket.onclose = (event) => {
      if (disposedRef.current) return;
      socketRef.current = null;
      setStatus('closed');
      agentStore.setConnection('closed', event.reason || `code ${event.code}`);
      scheduleRetry();
    };

    function scheduleRetry() {
      if (disposedRef.current || !enabled) return;
      attemptRef.current += 1;
      setAttempt(attemptRef.current);
      const backoff = Math.min(
        BASE_BACKOFF_MS * 2 ** (attemptRef.current - 1),
        MAX_BACKOFF_MS,
      );
      // Jitter keeps several open tabs from stampeding a restarting server.
      const delay = backoff * (0.7 + Math.random() * 0.6);
      clearTimer();
      timerRef.current = window.setTimeout(connect, delay);
    }
  }, [url, enabled]);

  useEffect(() => {
    disposedRef.current = false;
    if (enabled) {
      connect();
    } else {
      setStatus('idle');
      agentStore.setConnection('idle', 'offline mode');
    }

    return () => {
      disposedRef.current = true;
      clearTimer();
      const socket = socketRef.current;
      if (socket) {
        socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
        socket.close();
        socketRef.current = null;
      }
    };
  }, [connect, enabled]);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setAttempt(0);
    connect();
  }, [connect]);

  const send = useCallback((payload: unknown) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  return { status, attempt, reconnect, send };
}
