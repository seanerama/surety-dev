import sys
root, noask = sys.argv[1], sys.argv[2] == '1'
p = f'{root}/packages/engine/src/scheduler/tick.ts'
s = open(p).read()
helper = "\nimport { appendFileSync as __gwdAppend } from 'node:fs';\nconst __gwd = (what: string) => { const f = process.env.GWD_TICK_LOG; if (f) __gwdAppend(f, `${new Date().toISOString()} ${what}\\n`); };\n"
i = s.index('\n', s.rindex('\nimport ') + 1)
s = s[:i+1] + helper + s[i+1:]
s = s.replace("  private async tick(requests: number): Promise<void> {\n", "  private async tick(requests: number): Promise<void> {\n    __gwd(`tick start requests=${requests}`);\n", 1)
s = s.replace("        if (limit <= 0 || !(await withinBudget(this.step(name, project), limit))) ineligible.add(project);", "        __gwd(`step ${name} begin`);\n        if (limit <= 0 || !(await withinBudget(this.step(name, project), limit))) { ineligible.add(project); __gwd(`step ${name} over budget`); }\n        __gwd(`step ${name} end`);", 1)
s = s.replace("    await pausePoint('scheduler.tick_running');\n", "    __gwd('tick_running reached');\n    await pausePoint('scheduler.tick_running');\n    __gwd('tick_running passed');\n", 1)
s = s.replace("    await this.rt.engine('engine.tick', { incarnation: this.rt.incarnation, dispatched, requests, steps });\n", "    await this.rt.engine('engine.tick', { incarnation: this.rt.incarnation, dispatched, requests, steps });\n    __gwd(`tick end dispatched=${dispatched}`);\n", 1)
old = "    await this.rt.engine('fixes.ask_unjudged', { project }).catch((err) => log('unjudged fixes', err, { project }));\n"
assert s.count(old) == 1
s = s.replace(old, ("    // (removed in this private experiment copy only: objection 210)\n" if noask else "    __gwd('ask_unjudged begin');\n" + old + "    __gwd('ask_unjudged end');\n"), 1)
s = s.replace("  private async decide(project: string): Promise<void> {\n", "  private async decide(project: string): Promise<void> {\n    __gwd('decide begin');\n", 1)
open(p, 'w').write(s)
