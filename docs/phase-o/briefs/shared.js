const REPORT = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commit: { type: 'string' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string', description: 'tsc / vitest / e2e results with counts' },
    userFacing: { type: 'array', items: { type: 'string' } },
    apiNotes: { type: 'string', description: 'interfaces later engineers must use: exact exported names, signatures, file paths' },
    followUps: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'commit', 'summary', 'filesChanged', 'tests', 'apiNotes'],
}

const REVIEW = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commit: { type: 'string' },
    found: { type: 'array', items: { type: 'string' }, description: 'every real problem found' },
    fixed: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' }, description: 'problems not fixed, with why' },
    tests: { type: 'string' },
    userFacing: { type: 'array', items: { type: 'string' } },
    apiNotes: { type: 'string' },
  },
  required: ['branch', 'commit', 'found', 'fixed', 'remaining', 'tests'],
}

const HEAD = `You are one of two engineers working in parallel on the Cocaide CAD app (TypeScript/React/Three.js/OpenCascade WASM), which we are turning into a SOLIDWORKS-class part modeller ("smarter and cleaner than SOLIDWORKS, with all the little things"). Read /home/user/Cocaide/.plan/DESIGN.md first (the contract, including the rules in §3 for worktrees, tests, commits and your report), then /home/user/Cocaide/.plan/api.md (the registries that exist now: how to add a feature op, a model tool, a property editor), then the maps your task names. You are in your own git worktree (your current directory); the other engineer works in another worktree at the same time on other files. Take your time and do excellent, complete, well-tested work; think like a demanding SOLIDWORKS power user when you design the interactions.`

const reviewPrompt = (task, r, port) => `You are a senior reviewer and tester on the Cocaide CAD app (a SOLIDWORKS-class part modeller in TypeScript/React/Three.js/OpenCascade WASM). An engineer just finished the task below in the git worktree whose branch is "${r.branch}" (their commit ${r.commit}). Find its directory with: git -C /home/user/Cocaide worktree list | grep "\\[${r.branch}\\]". Work ONLY in that directory: start every Bash command with cd <that dir> &&, and give Read/Edit/Write absolute paths inside it. Never edit files in /home/user/Cocaide itself or in other worktrees. Run e2e there with PW_PORT=${port}. Read /home/user/Cocaide/.plan/DESIGN.md (rules §3 apply to you too) and /home/user/Cocaide/.plan/api.md.

The engineer's report:
${JSON.stringify(r, null, 1)}

THE TASK THEY WERE GIVEN:
${task}

Your job: review adversarially, test for real, and fix.
1. Read the whole diff (git diff $(git merge-base HEAD ccr-851589c3-2dh2fn)..HEAD) and the code around it. Check it against every numbered item of the task: what is missing, half done or wrong? Hunt for: geometry maths errors (signs, frames, normalisation, degrees vs radians), old documents or existing features that break, validation holes (unknown keys accepted, bad references accepted, wrong-kind refs), errors that do not say what to do, UI that renders but does nothing or acts on stale state, React key/state bugs, missing data-testids, keyboard paths that do not work, things drawn wrong or invisible, and tests that assert too little to catch a regression.
2. Exercise the user flows for real in the browser with focused Playwright specs (use e2e/helpers.ts), like a demanding SOLIDWORKS user would, and take screenshots of the key states (save them in the worktree's ignored test-results or the scratchpad, then Read the PNGs) to catch layout and visual problems: overlaps, clipped labels, wrapped toolbars, invisible or ugly geometry.
3. Fix every real problem you find, in scope; complete missing task items where you can. Do not rewrite working code for taste. Add regression tests for what you fix.
4. Run: npx tsc --noEmit -p . ; npx vitest run ; the e2e specs the branch added or touched plus the smoke set (DESIGN §3.5) — all must pass.
5. Commit in that worktree (trailers as DESIGN §3.6). Report what you found, what you fixed, and anything left.`

