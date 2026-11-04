// What the settings (and the README) tell the user about local models. Sizes
// are from the Ollama library's tag pages as listed in November 2026
// (qwen3.5:9b-q4_K_M 6.6 GB, qwen3.5:4b-q4_K_M 3.3 GB, both text and image
// input, 256K maximum context); check `ollama list` for what is installed.

export interface LocalModelGuide {
  tag: string;
  size: string;
  note: string;
}

export const RECOMMENDED_MODELS: LocalModelGuide[] = [
  {
    tag: "qwen3.5:9b",
    size: "6.6 GB (Q4_K_M)",
    note: "Recommended for an 8 GB GPU: tools, thinking and vision (drawings, photos, screenshots). At 16k context it may not fit wholly in 8 GB of video memory and part of it then runs on the CPU (slower); `ollama ps` shows the split.",
  },
  {
    tag: "qwen3.5:4b",
    size: "3.3 GB (Q4_K_M)",
    note: "The smaller fallback: fits an 8 GB GPU with room for a long context and answers faster, but follows long tool sequences less reliably.",
  },
];

export const CONTEXT_CHOICES: { value: number; label: string }[] = [
  { value: 8192, label: "8k: the least memory; long builds may lose earlier steps" },
  { value: 16384, label: "16k (recommended for 8 GB of video memory)" },
  { value: 24576, label: "24k" },
  { value: 32768, label: "32k: needs more memory; may spill to the CPU on 8 GB" },
  { value: 65536, label: "64k: large GPUs only" },
];

export const CONTEXT_HELP =
  "The context length (num_ctx) is how much of the ask the model holds at once: the instructions, the tools and the part are about 10k tokens before the conversation starts, so 16k is the practical minimum for edits and builds. Each step up needs more video memory for the cache; if the model no longer fits on the GPU, `ollama ps` shows a CPU/GPU split and answers get several times slower.";

export const THINK_HELP =
  "Thinking makes the model reason before it answers: sometimes better plans, always slower, and it uses the context. Off is the fastest and works well for most asks. Levels (low/medium/high) apply to models that have them; others treat any level as on.";
