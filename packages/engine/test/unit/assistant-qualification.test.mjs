// Developer tests for the workspace assistant's qualification (the assistant
// design §3; Sean's approval of O7(a)): its own template (Read and Write
// only; a version distinct from every role template's); a request with
// `"purpose": "assistant"` refused without the workspace_assistant block,
// otherwise bound to the assistant template and limited per canary by the
// turn limit, its spend estimate shown before approval from that limit and
// charged to the fixture project (B2's reservation of the turn limit); the
// assistant's canaries (a schema-valid reply citing the seeded evidence and
// carrying the nonce; the barrier written with Write; the containment
// actions adapted to a plan with no workspace) and the plan itself with no
// repository. No provider is called: the attempt itself runs in the sandbox
// lane on the scripted backend.

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const templates = await import(join(dist, 'invoke', 'adapters', 'templates.js'));
const { prepareQualify } = await import(join(dist, 'trust', 'qualify.js'));
const C = await import(join(dist, 'trust', 'canaries.js'));
const { validateReply, writeTurnPackage, boundedConversation } = await import(join(dist, 'assistant', 'turn-package.js'));
const { classifyNoRepositoryConfig, classifyWorkspaceAbsent } = await import(join(dist, 'invoke', 'probes', 'program.js'));
const { judgeContainment } = await import(join(dist, 'trust', 'attempts.js'));
const { buildPlan, planEntries } = await import(join(dist, 'invoke', 'sandbox', 'mounts.js'));
const { configureHarness } = await import(join(dist, 'testing', 'seam.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { qualify } = await import(join(dist, 'store', 'transitions', 'qualification.js'));
const trust = await import(join(dist, 'store', 'transitions', 'trust.js'));
const { requestedReservation } = await import(join(dist, 'store', 'transitions', 'qualification-budget.js'));
const { attemptCanaryLimit } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { hostIdentity } = await import(join(dist, 'trust', 'host.js'));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-waq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the assistant's template: Read and Write only, the same denied delegation tools, a version of its own, never a role's", () => {
  for (const mode of ['api_key', 'subscription_token']) {
    const a = templates.templateOf('claude', { authMode: mode, purpose: 'assistant' });
    const r = templates.templateOf('claude', { authMode: mode });
    assert.deepEqual([...a.tools], ['Read', 'Write']);
    assert.notEqual(a.version, r.version);
    assert.equal(templates.purposeOfTemplateVersion(a.version), 'assistant');
    assert.equal(templates.purposeOfTemplateVersion(r.version), 'role');
    const argv = a.render({ model: 'claude-sonnet-5-5', invocation: 'inv_X' });
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Write');
    for (const d of ['Agent', 'Task', 'ScheduleWakeup', 'Workflow']) assert.ok(argv.includes(d), `${d} denied`);
    assert.equal(argv.at(-1), templates.PROMPT);
    assert.equal(a.keyRef, r.keyRef, 'the same credential reference as the role template of the mode (O3)');
  }
  assert.equal(templates.templateOf('scripted', { purpose: 'assistant' }), undefined, 'the scripted form only where the test mode allows it');
  assert.equal(templates.templateOf('scripted', { purpose: 'assistant', scripted: true }).version, 'scripted-assistant-1');
  assert.equal(templates.templateOf('codex', { purpose: 'assistant' }), undefined, 'no assistant template for codex');
  // The test mode's version override is a role template's only.
  assert.equal(templates.templateOf('claude', { purpose: 'assistant', versions: { claude: 'x' } }).version, 'claude-assistant-1');
});

test('a request for the assistant: refused without the block; bound to the assistant template and its turn limit with it; one-shot only', async (t) => {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const dir = scratch(t);
  const bin = join(dir, 'standin');
  writeFileSync(bin, '#!/bin/sh\ncase "$1" in --version) echo "1.0 (stand-in)";; --help) echo "usage: standin";; esac\n');
  chmodSync(bin, 0o755);
  const body = { backend: 'scripted', mode: 'one_shot_headless', model: 'scripted', binary: { path: bin }, fixture_project: 'prj_fx', purpose: 'assistant' };
  await assert.rejects(prepareQualify(body, { fixtureProject: async () => 'prj_fx', home: dir, assistantTurnLimit: null }), (e) => e.code === 'assistant_not_configured' && e.status === 409);
  const r = await prepareQualify(body, { fixtureProject: async () => 'prj_fx', home: dir, assistantTurnLimit: 40_000 });
  assert.deepEqual([r.template_version, r.canary_limit_tokens, r.mode_requested], ['scripted-assistant-1', 40_000, 'one_shot_headless']);
  await assert.rejects(prepareQualify({ ...body, mode: 'session_headless' }, { fixtureProject: async () => 'prj_fx', home: dir, assistantTurnLimit: 40_000 }), (e) => e.subject?.field === 'mode');
  await assert.rejects(prepareQualify({ ...body, purpose: 'other' }, { fixtureProject: async () => 'prj_fx', home: dir, assistantTurnLimit: 40_000 }), (e) => e.subject?.field === 'purpose');
  const role = await prepareQualify({ ...body, purpose: undefined }, { fixtureProject: async () => 'prj_fx', home: dir, assistantTurnLimit: 40_000 });
  assert.deepEqual([role.template_version, role.canary_limit_tokens], ['scripted-1', null]);
});

test('the proposal: the spend estimated from the turn limit before approval, charged to the fixture project; B2 reserves the turn limit', (t) => {
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });
  const db = new Database(join(scratch(t), 'store.db'));
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  const AT = '2026-10-27T00:00:00.000Z';
  db.prepare(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_fx', ?, 'f', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`).run(AT);
  db.prepare(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES ('inc_1', ?, 1, ?, 'boot')`).run(AT, AT);
  db.prepare(`INSERT INTO records (id, created_at, project, kind, path, sha256, bytes, redaction_version, published, post_scan) VALUES ('rec_E1', ?, NULL, 'qualification_evidence', 'rec_E1', ?, 1, 'r1', 1, 'clean')`).run(AT, 'a'.repeat(64));
  transact(db, ENGINE_ACTOR, (tx) => trust.recordHostQualification(tx, { incarnation: 'inc_1', host_id: hostIdentity(), kernel: 'k', tool_versions: {}, mechanism_fingerprint: 'm', checks: [], probes: [], evidence: 'rec_E1' }));
  trust.setHostObserved({ checks: [], probes: [], duration_ms: null, scope_cgroup: null, wsl2: false, profile_fingerprint: 'prof-1' });
  const t0 = templates.templateOf('claude', { authMode: 'subscription_token', purpose: 'assistant' });
  const res = transact(db, ENGINE_ACTOR, (tx) =>
    qualify(tx, {
      backend: 'claude',
      mode: 'one_shot_headless',
      model: 'claude-sonnet-5-5',
      auth_mode: 'subscription_token',
      binary_path: '/opt/claude',
      binary_sha256: '1'.repeat(64),
      help_sha256: '2'.repeat(64),
      version: '2.1.288',
      template: t0.text,
      template_version: t0.version,
      candidate_egress: ['api.anthropic.com'],
      fixture_project: 'prj_fx',
      canary_deadlines: { positive: 900, cancellation: 600, containment: 900, continuation: 1800 },
      canary_limit_tokens: 40_000,
    }),
  );
  const a = trust.getAttempt(db, res.body.qualification_attempt.id);
  const spend = JSON.parse(a.spend);
  // Three canaries at 40,000 tokens at the output rate ($10 per million).
  assert.equal(spend.estimate, 1.2);
  assert.equal(spend.label, 'estimate');
  assert.match(spend.basis, /turn_limit_billable_tokens \(40000\)/);
  assert.deepEqual([spend.purpose, spend.canary_limit_tokens, spend.charged_to.project], ['assistant', 40_000, 'prj_fx']);
  assert.equal(attemptCanaryLimit(a), 40_000);
  assert.equal(requestedReservation(db, a), 40_000, "B2's reservation is the turn limit, not the fixture's 1,500,000 default");
  // The approval binds the spend.
  assert.deepEqual(trust.attemptManifest(db, a).spend, spend);
});

test("the assistant's canaries: the reply asked for is schema-valid, cites the seeded evidence and carries the nonce; the barrier is written with Write", () => {
  const attempt = 'qa_TEST';
  const pos = C.assistantCanaryInstructions({ attempt, kind: 'positive', deadlineSeconds: 900 });
  const ev = C.assistantCanaryEvidence(attempt);
  assert.equal(pos.evidence_id, ev.id);
  const ok = validateReply(pos.result, [ev.id]);
  assert.ok('reply' in ok);
  assert.ok(ok.reply.text.includes(C.assistantCanaryNonce(attempt)));
  assert.deepEqual(ok.reply.cited_evidence, [ev.id]);
  const cancel = C.assistantCanaryInstructions({ attempt, kind: 'cancellation', deadlineSeconds: 600 });
  assert.equal(cancel.barrier, C.CANARY_BARRIER);
  assert.ok(C.assistantCanaryPromptText(cancel).some((l) => /Write the file \/surety\/out\/canary-barrier/.test(l)));
  assert.ok(!C.assistantCanaryPromptText(cancel).some((l) => /shell command/.test(l)), 'no shell: the assistant has none');
  assert.deepEqual(
    C.ASSISTANT_CONTAINMENT_ACTIONS.map((x) => [x.name, x.expected]),
    [['token_read', 'denied'], ['git_config', 'denied'], ['engine_port', 'denied'], ['unlisted_connect', 'denied'], ['out_write', 'allowed'], ['workspace_absent', 'absent']],
  );
});

test('the reply is held to its schema and its evidence; links outside the console are dropped; no citation is commentary', () => {
  const ids = ['ae_1'];
  assert.match(validateReply({ text: 'x', cited_evidence: [], links: [], approve: true }, ids).invalid, /outside its schema/);
  assert.match(validateReply({ text: 'x', cited_evidence: ['ae_9'], links: [] }, ids).invalid, /did not supply/);
  assert.match(validateReply({ text: '', cited_evidence: [], links: [] }, ids).invalid, /no text/);
  assert.match(validateReply('hello', ids).invalid, /not a JSON object/);
  const r = validateReply({ text: 'see', cited_evidence: [], links: [{ label: 'a', href: '#/w/app/p' }, { label: 'b', href: 'https://evil.example/' }, { label: 'c', href: 'javascript:alert(1)' }] }, ids).reply;
  assert.deepEqual(r.links, [{ label: 'a', href: '#/w/app/p' }]);
  assert.equal(r.links_dropped, 2);
  assert.equal(r.commentary, true);
});

test("the package: the instructions, the request, the evidence, the conversation bounded, the schema; nothing else", (t) => {
  const dir = join(scratch(t), 'context');
  const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i} ${'x'.repeat(900)}`, created_at: `2026-10-27T00:00:${String(i).padStart(2, '0')}.000Z` }));
  const conversation = boundedConversation(long);
  assert.ok(conversation.length <= 10 && conversation.reduce((n, m) => n + m.text.length, 0) <= 12_000);
  assert.equal(conversation.at(-1).text, long.at(-1).text, 'newest last');
  writeTurnPackage(dir, { request: { intent_id: 'i', text: 'What is waiting?', context: { project: null, screen: 'home' } }, evidence: [], conversation });
  assert.deepEqual(readdirSync(dir).sort(), ['conversation.json', 'evidence.json', 'prompt.md', 'reply-schema.json', 'request.json']);
  assert.match(readFileSync(join(dir, 'prompt.md'), 'utf8'), /Never approve, decide, configure or instruct an action/);
});

test('the probe classifies the no-repository actions as the sandbox decides them, an unknown never a denial', () => {
  assert.equal(classifyNoRepositoryConfig({ status: 255, present: false, made: 'EROFS' }), 'denied');
  assert.equal(classifyNoRepositoryConfig({ status: 255, present: false, made: 'made' }), 'allowed');
  assert.equal(classifyNoRepositoryConfig({ status: 0, present: false, made: 'EROFS' }), 'allowed');
  assert.equal(classifyNoRepositoryConfig({ status: 255, present: false, made: 'EIO' }), 'not_run');
  assert.equal(classifyWorkspaceAbsent({ stat: 'ENOENT', made: 'EROFS' }), 'absent');
  assert.equal(classifyWorkspaceAbsent({ stat: 'exists', made: 'EEXIST' }), 'present');
  assert.equal(classifyWorkspaceAbsent({ stat: 'ENOENT', made: 'made' }), 'present');
  assert.equal(classifyWorkspaceAbsent({ stat: 'EIO', made: 'EROFS' }), 'not_run');
});

test("the containment judgement on the assistant's actions: every one as expected, out_write the control", () => {
  const hardening = ['--disable-sigusr1', '--disallow-code-generation-from-strings', '--no-addons'];
  const w = (action, outcome) => ({ action, outcome, detail: '', completed: true, backend_running: true, hardening });
  const witnesses = C.ASSISTANT_CONTAINMENT_ACTIONS.map((x) => w(x.name, x.expected));
  const watch = { ns_pid: 2, seen: { host_pid: 5, at: 'a' }, requested_at: 'b', present_at_end: true, ended_at: 'c', reason: null };
  const done = { ran: true, backend_running: true, reason: null };
  const corroboration = { token_read: { checked: true, agrees: true, what: '' }, git_config: { checked: true, agrees: true, what: '' }, unlisted_connect: { checked: true, agrees: true, what: '' } };
  const ok = judgeContainment({ actions: C.ASSISTANT_CONTAINMENT_ACTIONS, witnesses, watch, done, corroboration, providerTunnel: null });
  assert.equal(ok.passed, true, ok.reason);
  assert.deepEqual(ok.controls.map((c) => [c.name, c.ran]), [['out_write', true]]);
  const present = judgeContainment({ actions: C.ASSISTANT_CONTAINMENT_ACTIONS, witnesses: witnesses.map((x) => (x.action === 'workspace_absent' ? { ...x, outcome: 'present' } : x)), watch, done, corroboration, providerTunnel: null });
  assert.equal(present.passed, false);
  assert.match(present.reason, /workspace_absent \(present, expected absent\)/);
});

test('a plan with no repository: /surety holds exactly context, home and out; no workspace overlay, no git view', (t) => {
  const area = scratch(t);
  const tools = { mount: '/usr/bin/mount', umount: '/usr/bin/umount', pivot_root: '/usr/sbin/pivot_root', ip: '/usr/sbin/ip', unshare: '/usr/bin/unshare', setpriv: '/usr/bin/setpriv' };
  const plan = buildPlan({ area, context: area, workspace: null, readPaths: [], writablePaths: [], volBytes: 1 << 20, volInodes: 64, shmBytes: 1 << 20, tools, node: process.execPath, initNodeCopy: process.execPath, initScript: process.execPath });
  const surety = plan.skeleton.filter((e) => /^surety\/[^/]+$/.test(e.path)).map((e) => e.path.slice('surety/'.length));
  assert.deepEqual([...new Set(surety)].sort(), ['context', 'home', 'out']);
  assert.equal(plan.workspaceMount, undefined);
  const targets = planEntries(plan).map((e) => e.target);
  assert.ok(!targets.some((x) => x.startsWith('/surety/workspace') || x.startsWith('/surety/git')), targets.join(', '));
  assert.ok(!planEntries(plan).some((e) => e.kind === 'overlay'));
  assert.equal(planEntries(plan).find((e) => e.target === '/surety/context').options.includes('ro'), true);
});
