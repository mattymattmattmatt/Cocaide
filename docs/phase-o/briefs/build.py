import sys
n, desc = sys.argv[1], sys.argv[2]
meta = f"""export const meta = {{
  name: 'phase-o-wave{n}',
  description: {desc!r},
  phases: [
    {{ title: 'Build', detail: 'two isolated worktree engineers' }},
    {{ title: 'Review', detail: 'a skeptical reviewer per branch tests and fixes it' }},
  ],
}}

"""
tail = f"""
const results = await pipeline(
  ITEMS,
  (it) => agent(it.prompt, {{ label: `W{n}${{it.key}} build: ${{it.label}}`, phase: 'Build', isolation: 'worktree', schema: REPORT }}),
  (r, it) => (r ? agent(reviewPrompt(it.prompt, r, it.port), {{ label: `W{n}${{it.key}} review: ${{it.label}}`, phase: 'Review', schema: REVIEW }}).then((v) => ({{ build: r, review: v }})) : null),
)
return {{ A: results[0], B: results[1] }}
"""
open(f'wave{n}.js','w').write(meta + open('shared.js').read() + "\n" + open(f'w{n}-tasks.js').read() + tail)
