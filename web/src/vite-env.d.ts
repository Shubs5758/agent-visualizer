/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the ingestion bridge. Defaults to ws://localhost:8765. */
  readonly VITE_VISUALIZER_WS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
