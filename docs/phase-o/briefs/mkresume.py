import sys,re
n, run = sys.argv[1], sys.argv[2]
s=open(f'wave{n}.js').read()
s=s.replace(f"name: 'phase-o-wave{n}'",f"name: 'phase-o-wave{n}-resume'")
for i,k in ((1,'A'),(2,'B')):
    s=re.sub(r"(\{ key: '%s', label: '[^']*', prompt: %s, port: \d+)( \})"%(k,k), r"\1, dir: '/home/user/Cocaide/.claude/worktrees/%s-%d', branch: 'worktree-%s-%d'\2"%(run,i,run,i), s)
cont = """const resume = (it) => `IMPORTANT — YOU ARE CONTINUING INTERRUPTED WORK. An earlier engineer did part of the task below and was cut off by a usage limit; their work is committed on branch ${it.branch} in the git worktree ${it.dir} (see git log ccr-851589c3-2dh2fn..HEAD). Work ONLY in that directory: start every Bash command with cd ${it.dir} &&, and give Read/Edit/Write absolute paths inside it (never edit /home/user/Cocaide itself or other worktrees). First read what is done (git log, git diff ccr-851589c3-2dh2fn --stat, the files); then finish every remaining numbered item, fix what is broken, run ALL the checks the task names, and commit (trailers per DESIGN §3.6). Your report's branch is ${it.branch}.\\n\\n` + it.prompt
"""
s=s.replace("const ITEMS", cont+"\nconst ITEMS",1)
old="(it) => agent(it.prompt, { label: `W%s${it.key} build: ${it.label}`, phase: 'Build', isolation: 'worktree', schema: REPORT })"%n
assert old in s and "dir: '" in s
s=s.replace(old,"(it) => agent(resume(it), { label: `W%s${it.key} finish: ${it.label}`, phase: 'Build', schema: REPORT })"%n)
open(f'wave{n}r.js','w').write(s)
print('ok')
