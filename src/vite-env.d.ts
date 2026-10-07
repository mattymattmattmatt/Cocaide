/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Test hook: recycle the kernel at this many MB of WASM heap instead of the default. */
  readonly VITE_COCAIDE_RECYCLE_MB?: string;
  /** "1" when the dev server proxies /anthropic to the API with its own key (ANTHROPIC_API_KEY). */
  readonly VITE_COCAIDE_ANTHROPIC_PROXY?: string;
}
