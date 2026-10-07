/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Test hook: recycle the kernel at this many MB of WASM heap instead of the default. */
  readonly VITE_COCAIDE_RECYCLE_MB?: string;
}
