// M506, the design check (slice 41; kernel lane). M6 plan §3.3 M506; D7
// §5.5, §5.6 clauses 1 to 7, §4.4, §14; A.4; Q3; BS6 §4.1 rule 21;
// SEAM.md §§483, 493.
//
// A minimal fault for each reason, each a save of the whole design with one
// change, each recorded on a `design_check` record naming its subjects and
// the target, after a save of the same design without it that passes:
// (a) clause 1, DESIGN_SCHEMA_INVALID, DESIGN_INVENTORY_STALE;
// (b) clause 2, DESIGN_UNKNOWN_REQUIREMENT, DESIGN_UNKNOWN_INTERFACE,
//     DESIGN_UNKNOWN_TARGET, DESIGN_MOCKUP_MISSING, DESIGN_MOCKUP_ORPHAN,
//     and DESIGN_FIXTURE_INVALID for a file under mockups/data/;
// (c) clause 3, DESIGN_REQUIREMENT_UNCOVERED, DESIGN_STATE_UNCOVERED,
//     DESIGN_LAYOUT_UNCOVERED, DESIGN_INPUT_UNLABELLED, each per target;
// (d) clause 4, DESIGN_NAV_UNKNOWN_SCREEN, DESIGN_SCREEN_UNREACHABLE,
//     DESIGN_CONVENTION_UNDECLARED per §5.3's table for each of the six
//     targets, DESIGN_SHORTCUT_DUPLICATE, and a convention field not
//     applicable to the screen's target;
// (e) clause 5, DESIGN_TOKEN_UNDEFINED; pairs at 4.49:1 and 4.50:1 in each
//     selected theme, DESIGN_CONTRAST_BELOW_AA at 4.49 and none at 4.50;
// (f) clause 6, DESIGN_MOCKUP_KIND_MISMATCH for each kind outside its
//     admitted targets and capabilities, DESIGN_EXTERNAL_URL_UNPINNED for an
//     unversioned URL and for a host outside design_external_urls;
// (g) design_tree_max_bytes and design_tree_max_files (lowered): the save
//     refused design_tree_too_large (413) naming the bound; binary files of
//     the four formats admitted and counted;
// (h) a tree whose mockup script and SVG would each write a marker file if
//     run: no process started by the check, no marker written;
// (i) the check at every save and at close: one design_check record per
//     save, design.checked; close refused until one passes.
// (a) to (f): the reasons are the next turn's engine entry.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { changePolicy } from './harness/journal.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { postCloseRaw, postSaveRaw } from './harness/session-lane.mjs';
import { sayAndSettle, scriptTurns, turnResult } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';
import { designEvents, inventoryOf, openDesigner, toPublished } from './harness/design/drive.mjs';
import {
  BEFORE_BUILD,
  assertNoReason,
  assertPassed,
  assertReason,
  checkOf,
  checkSession,
  codesIn,
  designCheckRow,
  designModel,
  designTurnOf,
  engineEntryText,
  flatPng,
  icoOf,
  mockupEntry,
  screenOf,
  scriptVariant,
  svgOf,
  toSixPublished,
  variantOf,
  webpOf,
} from './harness/design/check41.mjs';

const MIB = 1024 * 1024;
const KIB = 1024;

// Any Designer session of the project left open by a failed case, closed.
async function closeOpenDesigners(fx, project) {
  const open = withStore(fx.home, (db) => db.prepare(`SELECT "id" FROM "runs" WHERE "project" = ? AND "role" = 'designer' AND "state" <> 'ended'`).all(project));
  for (const r of open) await postCloseRaw(fx, project, r.id, { refuse: true });
}

// For every save answered with a check: its design_checks row (A.3) with the
// same outcome and reasons; one design.checked per such save; and (a) to
// (f)'s rule, a refused check's reasons in the next turn's engine entry.
function assertRecorded(fx, project, out, checkedBefore, what) {
  const checked = out.saves.filter((s) => checkOf(s.res));
  for (const s of checked) {
    const c = checkOf(s.res);
    const row = designCheckRow(fx.home, c.id);
    assert.ok(row, `${what}, ${s.name}: the design_check record ${c.id} is in the store (D7 A.3)`);
    assert.equal(row.outcome, c.outcome, `${what}, ${s.name}: the record's outcome is the save's`);
    if (c.outcome === 'refused') {
      const text = engineEntryText(fx.home, out.run.id, s.turn + 1);
      for (const code of new Set(codesIn(s.res))) assert.ok(text.includes(code), `${what}, ${s.name}: ${code} is the next turn's engine entry (turn ${s.turn + 1}: ${text.slice(0, 400)})`);
    }
  }
  assert.equal(designEvents(fx.home, 'design.checked', project).length - checkedBefore, checked.length, `${what}: one design.checked per checked save`);
}

describe('M506 the design check', () => {
  const shared = sharedFixture();
  after(() => shared.cleanup());
  // Pantry (web, android) and Pantry everywhere (six targets), published under
  // before_build, made once by the first case that needs each.
  let made = {};
  const fixture = (kind) =>
    (made[kind] ??= (async () => {
      const fx = await scriptedEngine(shared.context);
      const { p } = kind === 'six' ? await toSixPublished(fx) : await toPublished(fx, { policy: BEFORE_BUILD });
      scriptVariant(fx, p);
      const inventory = inventoryOf(p);
      return { fx, p, inventory, model: designModel(inventory) };
    })());

  // One fault session: the valid design first (it passes), then each case.
  async function faults(kind, cases, what) {
    const { fx, p, model } = await fixture(kind);
    await closeOpenDesigners(fx, p.id);
    const before = designEvents(fx.home, 'design.checked', p.id).length;
    const out = await checkSession(fx, p.id, [{ name: 'the valid design', model }, ...cases]);
    assertPassed(out.saves[0].res, `${what}: the valid design (the control)`);
    return { fx, p, out, before, saves: Object.fromEntries(out.saves.map((s) => [s.name, s.res])) };
  }

  test('(a) clause 1: DESIGN_SCHEMA_INVALID naming the field; DESIGN_INVENTORY_STALE', async () => {
    const { model, inventory } = await fixture('base');
    const stale = '0'.repeat(64);
    const cases = [
      { name: 'an unknown field in design.json', model: variantOf(model, (m) => (m.design.colour = 'blue')) },
      { name: 'an unknown field on a screen', model: variantOf(model, (m) => (screenOf(m, 'S1').colour = 'blue')) },
      { name: 'a stale inventory digest', model: variantOf(model, (m) => (m.design.inventory_digest = stale)) },
    ];
    const { fx, p, out, before, saves } = await faults('base', cases, '(a)');
    assertReason(saves['an unknown field in design.json'], 'DESIGN_SCHEMA_INVALID', ['colour'], 'an unknown field in design.json');
    assertReason(saves['an unknown field on a screen'], 'DESIGN_SCHEMA_INVALID', ['colour', 'S1'], 'an unknown field on a screen');
    const r = assertReason(saves['a stale inventory digest'], 'DESIGN_INVENTORY_STALE', [], 'a stale inventory digest');
    assert.ok(JSON.stringify(r).includes(stale) || JSON.stringify(r).includes(inventory.inventory_digest), `naming the digests (${JSON.stringify(r)})`);
    assertRecorded(fx, p.id, out, before, '(a)');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(b) clause 2: unknown requirement, interface and target; a mockup missing and one orphaned; an invalid file under mockups/data/', async () => {
    const { model } = await fixture('base');
    const ios = (m) => {
      const s1 = screenOf(m, 'S1');
      m.screens.screens.push({ ...structuredClone(s1), key: 'S3', target: 'ios', states: [], conventions: { container: 'stack', edge_swipe_back: true, safe_area_edges: ['top', 'bottom'] } });
    };
    const cases = [
      { name: 'a requirement no UI requirement of the target', model: variantOf(model, (m) => (screenOf(m, 'S1').requirements = ['R2', 'R1'])) },
      { name: 'an interface the inventory does not hold', model: variantOf(model, (m) => screenOf(m, 'S1').interfaces.push('health')) },
      { name: 'a screen of a target the inventory does not hold', model: variantOf(model, ios) },
      { name: 'a mockup named and missing', model: variantOf(model, (m) => delete m.mockups['mockups/web/s1.html']) },
      { name: 'a mockup no screen names', model: variantOf(model, (m) => (m.mockups['mockups/web/unused.html'] = '<!doctype html><title>unused</title>\n')) },
      { name: 'an invalid file under mockups/data/', model: variantOf(model, (m) => (m.mockups['mockups/data/list-items.ok.json'] = '{"items": [{"name": "rice", "quantity": "two"}]}\n')) },
      { name: 'a valid file under mockups/data/ (the control)', model: variantOf(model, (m) => (m.mockups['mockups/data/list-items.ok.json'] = '{"items": [{"name": "rice", "quantity": 2}]}\n')) },
    ];
    const { fx, p, out, before, saves } = await faults('base', cases, '(b)');
    assertReason(saves[cases[0].name], 'DESIGN_UNKNOWN_REQUIREMENT', ['R1', 'web'], cases[0].name);
    assertReason(saves[cases[1].name], 'DESIGN_UNKNOWN_INTERFACE', ['health', 'web'], cases[1].name);
    assertReason(saves[cases[2].name], 'DESIGN_UNKNOWN_TARGET', ['ios', 'S3'], cases[2].name);
    assertReason(saves[cases[3].name], 'DESIGN_MOCKUP_MISSING', ['mockups/web/s1.html', 'web'], cases[3].name);
    assertReason(saves[cases[4].name], 'DESIGN_MOCKUP_ORPHAN', ['mockups/web/unused.html'], cases[4].name);
    assertReason(saves[cases[5].name], 'DESIGN_FIXTURE_INVALID', ['mockups/data/list-items.ok.json'], cases[5].name);
    assertPassed(saves[cases[6].name], cases[6].name);
    assertRecorded(fx, p.id, out, before, '(b)');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(c) clause 3, per target: a requirement uncovered, a state uncovered, a layout uncovered, an input unlabelled', async () => {
    const { model } = await fixture('base');
    const cases = [
      { name: 'R2 on no web screen', model: variantOf(model, (m) => (screenOf(m, 'S1').requirements = [])) },
      { name: 'list-items empty missing on web', model: variantOf(model, (m) => (screenOf(m, 'S1').states = screenOf(m, 'S1').states.filter((s) => !(s.obligation.interface === 'list-items' && s.obligation.state === 'empty')))) },
      { name: 'permission_denied:notifications missing on android', model: variantOf(model, (m) => (screenOf(m, 'S2').states = screenOf(m, 'S2').states.filter((s) => !s.obligation.permission))) },
      { name: 'web without its 1280 layout', model: variantOf(model, (m) => (screenOf(m, 'S1').layouts = screenOf(m, 'S1').layouts.filter((l) => l !== 1280))) },
      { name: 'android without phone-landscape', model: variantOf(model, (m) => (screenOf(m, 'S2').layouts = screenOf(m, 'S2').layouts.filter((l) => l !== 'phone-landscape'))) },
      { name: 'the web quantity label without its unit', model: variantOf(model, (m) => (screenOf(m, 'S1').inputs.find((i) => i.property === 'quantity').label = 'Quantity')) },
      { name: 'no android input for quantity', model: variantOf(model, (m) => (screenOf(m, 'S2').inputs = screenOf(m, 'S2').inputs.filter((i) => i.property !== 'quantity'))) },
    ];
    const { fx, p, out, before, saves } = await faults('base', cases, '(c)');
    assertReason(saves[cases[0].name], 'DESIGN_REQUIREMENT_UNCOVERED', ['R2', 'web'], cases[0].name);
    assertReason(saves[cases[1].name], 'DESIGN_STATE_UNCOVERED', ['web', 'list-items', 'empty'], cases[1].name);
    assertReason(saves[cases[2].name], 'DESIGN_STATE_UNCOVERED', ['android', 'notifications'], cases[2].name);
    assertReason(saves[cases[3].name], 'DESIGN_LAYOUT_UNCOVERED', ['web', '1280'], cases[3].name);
    assertReason(saves[cases[4].name], 'DESIGN_LAYOUT_UNCOVERED', ['android', 'phone-landscape'], cases[4].name);
    assertReason(saves[cases[5].name], 'DESIGN_INPUT_UNLABELLED', ['web', 'quantity'], cases[5].name);
    assertReason(saves[cases[6].name], 'DESIGN_INPUT_UNLABELLED', ['android', 'quantity'], cases[6].name);
    assertRecorded(fx, p.id, out, before, '(c)');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(d) clause 4: an edge to a screen of another target; a screen unreachable from an entry', async () => {
    const { model } = await fixture('base');
    const nav = (m, target) => m.navigation.targets.find((t) => t.target === target);
    const cases = [
      { name: 'a web edge to the android screen', model: variantOf(model, (m) => (nav(m, 'web').edges = [{ from: 'S1', to: 'S2', trigger: 'tap Add', kind: 'push' }])) },
      { name: 'web with no entry', model: variantOf(model, (m) => (nav(m, 'web').entries = [])) },
    ];
    const { fx, p, out, before, saves } = await faults('base', cases, '(d)');
    assertReason(saves[cases[0].name], 'DESIGN_NAV_UNKNOWN_SCREEN', ['web', 'S2'], cases[0].name);
    assertReason(saves[cases[1].name], 'DESIGN_SCREEN_UNREACHABLE', ['web', 'S1'], cases[1].name);
    assertRecorded(fx, p.id, out, before, '(d)');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(d) clause 4 on the six targets: DESIGN_CONVENTION_UNDECLARED per §5.3 for each; a field not applicable to the target; DESIGN_SHORTCUT_DUPLICATE', async () => {
    const { model } = await fixture('six');
    const keyOf = model.keyOf;
    // One required convention dropped per target (SEAM.md §484's fields).
    const DROPPED = { web: 'browser_back', android: 'gestures', ios: 'safe_area_edges', macos: 'menu_entries', windows: 'shortcuts', linux: 'window_min' };
    const cases = [
      ...Object.entries(DROPPED).map(([target, field]) => ({ name: `${target} without ${field}`, target, field, model: variantOf(model, (m) => delete screenOf(m, keyOf[target]).conventions[field]) })),
      { name: 'android without permissions (the target has one)', model: variantOf(model, (m) => delete screenOf(m, keyOf.android).conventions.permissions) },
      { name: 'an ios field on the web screen', model: variantOf(model, (m) => (screenOf(m, keyOf.web).conventions.safe_area_edges = ['top'])) },
      { name: 'one shortcut twice in one macos window', model: variantOf(model, (m) => screenOf(m, keyOf.macos).conventions.shortcuts.push({ action: 'clear', keys: 'Ctrl+N' })) },
    ];
    const { fx, p, out, before, saves } = await faults('six', cases, '(d) six targets');
    for (const c of cases.filter((x) => x.field)) assertReason(saves[c.name], 'DESIGN_CONVENTION_UNDECLARED', [c.target, keyOf[c.target], c.field], c.name);
    assertReason(saves['android without permissions (the target has one)'], 'DESIGN_CONVENTION_UNDECLARED', ['android', keyOf.android, 'permissions'], 'android without permissions');
    assertReason(saves['an ios field on the web screen'], 'DESIGN_SCHEMA_INVALID', ['safe_area_edges', keyOf.web], 'a convention field not applicable to the screen\'s target (B.12; SEAM.md §493)');
    assertReason(saves['one shortcut twice in one macos window'], 'DESIGN_SHORTCUT_DUPLICATE', ['macos', keyOf.macos, 'Ctrl+N'], 'a shortcut duplicated within one window');
    assertRecorded(fx, p.id, out, before, '(d) six targets');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(e) clause 5: a token a pair names undefined in one selected theme; pairs at 4.49:1 and 4.50:1 in each theme, from the declared hex values', async () => {
    const { model } = await fixture('base');
    // WCAG 2 contrast (SEAM.md §493): #647a87 on #ffffff 4.4915:1; #647b7c on #ffffff 4.5006:1;
    // #64827e on #121212 4.4927:1; #648092 on #121212 4.5002:1 (either linearization threshold).
    const primary = (theme, hex) => variantOf(model, (m) => (m.tokens.themes[theme]['color.text.primary'] = hex));
    const cases = [
      {
        name: 'color.text.muted undefined in dark',
        model: variantOf(model, (m) => {
          m.tokens.themes.light['color.text.muted'] = '#555555';
          m.tokens.pairs.push({ text: 'color.text.muted', background: 'color.surface.base' });
        }),
      },
      { name: 'light at 4.49:1', model: primary('light', '#647a87') },
      { name: 'light at 4.50:1', model: primary('light', '#647b7c') },
      { name: 'dark at 4.49:1', model: primary('dark', '#64827e') },
      { name: 'dark at 4.50:1', model: primary('dark', '#648092') },
    ];
    const { fx, p, out, before, saves } = await faults('base', cases, '(e)');
    assertReason(saves[cases[0].name], 'DESIGN_TOKEN_UNDEFINED', ['color.text.muted', 'dark'], cases[0].name);
    assertReason(saves['light at 4.49:1'], 'DESIGN_CONTRAST_BELOW_AA', ['light', 'color.text.primary'], 'light at 4.49:1');
    assertNoReason(saves['light at 4.50:1'], 'DESIGN_CONTRAST_BELOW_AA', 'light at 4.50:1');
    assertPassed(saves['light at 4.50:1'], 'light at 4.50:1');
    assertReason(saves['dark at 4.49:1'], 'DESIGN_CONTRAST_BELOW_AA', ['dark', 'color.text.primary'], 'dark at 4.49:1');
    assertNoReason(saves['dark at 4.50:1'], 'DESIGN_CONTRAST_BELOW_AA', 'dark at 4.50:1');
    assertPassed(saves['dark at 4.50:1'], 'dark at 4.50:1');
    assertRecorded(fx, p.id, out, before, '(e)');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(f) clause 6: each mockup kind outside its targets and capabilities; an unversioned URL and a host off the allowlist; a pinned URL admitted', async () => {
    const { model } = await fixture('base');
    const withUrl = (url) =>
      variantOf(model, (m) => {
        m.mockups['mockups/web/s1.html'] = m.mockups['mockups/web/s1.html'].replace('</head>', `<script type="module" src="${url}"></script></head>`);
        mockupEntry(m, 'web').external_urls = [url];
      });
    const UNVERSIONED = 'https://cdn.jsdelivr.net/npm/three/build/three.module.js';
    const OFF_LIST = 'https://example.com/npm/three@0.160.0/build/three.module.js';
    const PINNED = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
    const cases = [
      {
        name: 'static_html on android (simulated)',
        model: variantOf(model, (m) => {
          mockupEntry(m, 'android').kind = 'static_html';
          delete mockupEntry(m, 'android').simulates;
        }),
      },
      { name: 'scene_html on web under html_css', model: variantOf(model, (m) => (mockupEntry(m, 'web').kind = 'scene_html')) },
      {
        name: 'simulated_html on web (native)',
        model: variantOf(model, (m) => {
          mockupEntry(m, 'web').kind = 'simulated_html';
          mockupEntry(m, 'web').simulates = { target: 'web', layout: 360 };
        }),
      },
      { name: 'an unversioned URL', model: withUrl(UNVERSIONED) },
      { name: 'a host outside design_external_urls', model: withUrl(OFF_LIST) },
      { name: 'a pinned URL on the allowlist', model: withUrl(PINNED) },
    ];
    const { fx, p, out, before, saves } = await faults('base', cases, '(f)');
    assertReason(saves[cases[0].name], 'DESIGN_MOCKUP_KIND_MISMATCH', ['android', 'static_html'], cases[0].name);
    assertReason(saves[cases[1].name], 'DESIGN_MOCKUP_KIND_MISMATCH', ['web', 'scene_html'], cases[1].name);
    assertReason(saves[cases[2].name], 'DESIGN_MOCKUP_KIND_MISMATCH', ['web', 'simulated_html'], cases[2].name);
    assertReason(saves['an unversioned URL'], 'DESIGN_EXTERNAL_URL_UNPINNED', [UNVERSIONED], 'an unversioned URL');
    assertReason(saves['a host outside design_external_urls'], 'DESIGN_EXTERNAL_URL_UNPINNED', [OFF_LIST], 'a host outside design_external_urls');
    assertPassed(saves['a pinned URL on the allowlist'], 'a pinned URL on the allowlist');
    assertRecorded(fx, p.id, out, before, '(f)');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });

  test('(h) a mockup script, a script file and an SVG that would each write a marker if run: the check starts no process and nothing is written', async () => {
    const { fx, p, model } = await fixture('base');
    await closeOpenDesigners(fx, p.id);
    const markers = join(fx.root, 'm506-markers');
    mkdirSync(markers, { recursive: true });
    const marker = (name) => join(markers, name);
    const nodeWrite = (name) => `import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(marker(name))}, 'ran'));`;
    const active = variantOf(model, (m) => {
      m.mockups['mockups/web/s1.html'] = m.mockups['mockups/web/s1.html'].replace('</body>', `<script type="module">${nodeWrite('inline-script')}</script>\n<script type="module" src="s1.mjs"></script>\n</body>`);
      m.mockups['mockups/web/s1.mjs'] = `${nodeWrite('script-file')}\n`;
      m.mockups['mockups/web/s1.svg'] = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="require('node:fs').writeFileSync(${JSON.stringify(marker('svg-onload'))}, 'ran')"><script><![CDATA[require('node:fs').writeFileSync(${JSON.stringify(marker('svg-script'))}, 'ran');]]></script></svg>\n`;
      m.design.mockups.push({ path: 'mockups/web/s1.svg', kind: 'image', screens: ['S1'], external_urls: [] });
    });
    // The process inventory around the check: the engine's descendants,
    // sampled while the save is in flight, any that names the tree's files.
    const descendants = (pid) => {
      const out = [];
      const walk = (p) => {
        let tasks = [];
        try {
          tasks = readdirSync(`/proc/${p}/task`);
        } catch {
          return;
        }
        for (const t of tasks) {
          let kids = [];
          try {
            kids = readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
          } catch {
            kids = [];
          }
          for (const k of kids) {
            let cmd = '';
            try {
              cmd = readFileSync(`/proc/${k}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
            } catch {
              cmd = '';
            }
            out.push({ pid: k, cmd });
            walk(k);
          }
        }
      };
      walk(pid);
      return out;
    };
    const suspicious = (d) => /mockups\/|m506-markers|\.svg\b|s1\.mjs/.test(d.cmd) && !/^(\S*\/)?git(\s|$)/.test(d.cmd);
    const run = await openDesigner(fx, p.id);
    scriptTurns(fx, run.id, [designTurnOf(active), { steps: [step.result(turnResult({ reply: 'Noted.' }))] }]);
    await sayAndSettle(fx, p.id, run.id, 'Draw it with scripts.');
    const seen = [];
    let saving = true;
    const sampler = (async () => {
      while (saving) {
        for (const d of descendants(fx.engine.pid)) if (suspicious(d)) seen.push(d);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    const before = descendants(fx.engine.pid).filter(suspicious);
    const res = await postSaveRaw(fx, p.id, run.id);
    saving = false;
    await sampler;
    const afterList = descendants(fx.engine.pid).filter(suspicious);
    assert.equal(res.status, 200, `the save answers with its check (${res.status} ${res.text?.slice(0, 400)})`);
    assert.ok(checkOf(res), 'the design check ran on the tree');
    assert.deepEqual([before, seen, afterList], [[], [], []], 'no process naming the tree\'s files before, during or after the check');
    for (const name of ['inline-script', 'script-file', 'svg-onload', 'svg-script']) assert.equal(existsSync(marker(name)), false, `no marker ${name}: nothing the Designer wrote was run`);
    await sayAndSettle(fx, p.id, run.id, 'Done.');
    await postCloseRaw(fx, p.id, run.id, { refuse: true });
  });

  test('(i) the check at every save and at close: one design_check record and one design.checked per save; close refused design_check_failed until a save passes', async () => {
    const { fx, p, model } = await fixture('base');
    await closeOpenDesigners(fx, p.id);
    const faulty = variantOf(model, (m) => (screenOf(m, 'S1').states = screenOf(m, 'S1').states.filter((s) => !(s.obligation.interface === 'list-items' && s.obligation.state === 'empty'))));
    const events = () => designEvents(fx.home, 'design.checked', p.id).length;
    const run = await openDesigner(fx, p.id);
    scriptTurns(fx, run.id, [designTurnOf(faulty), designTurnOf(model)]);
    const n0 = events();
    await sayAndSettle(fx, p.id, run.id, 'Draw it.');
    const first = await postSaveRaw(fx, p.id, run.id);
    assertReason(first, 'DESIGN_STATE_UNCOVERED', ['web', 'empty'], 'the first save');
    assert.ok(designCheckRow(fx.home, checkOf(first).id), 'its design_check record');
    assert.equal(events() - n0, 1, 'one design.checked for the first save');
    const refused = await postCloseRaw(fx, p.id, run.id, {});
    assert.equal(refused.status, 422, `close refused while the last check refused (${refused.status} ${refused.text?.slice(0, 400)})`);
    assert.equal(refused.body?.code, 'design_check_failed', 'design_check_failed (D7 A.6)');
    assert.ok(JSON.stringify(refused.body).includes('DESIGN_STATE_UNCOVERED'), 'with its reasons');
    await sayAndSettle(fx, p.id, run.id, 'Fix it.');
    const n1 = events();
    const second = await postSaveRaw(fx, p.id, run.id);
    assertPassed(second, 'the corrected save');
    assert.notEqual(checkOf(second).id, checkOf(first).id, 'a record of its own');
    assert.ok(designCheckRow(fx.home, checkOf(second).id), 'its design_check record');
    assert.ok(events() - n1 >= 1, 'design.checked for the second save');
    const closed = await postCloseRaw(fx, p.id, run.id, {});
    assert.equal(closed.status, 200, `close accepted once a save passed (${closed.status} ${closed.text?.slice(0, 400)})`);
  });

  test('(g) design_tree_max_files and design_tree_max_bytes lowered: 413 design_tree_too_large naming the bound, nothing committed; binary files of the four formats admitted and counted', async () => {
    const { fx, p, model } = await fixture('base');
    await closeOpenDesigners(fx, p.id);
    // Four binary files of D7 §5.5's formats, `each` bytes or so: image
    // mockups of S1 (png, webp, svg) and an icon file beside them (ico).
    const binaries = (each) =>
      variantOf(model, (m) => {
        const png = flatPng(64, 48, { pad: each });
        m.mockups['mockups/web/s1.png'] = png;
        m.mockups['mockups/web/s1.webp'] = webpOf(64, 48, { pad: each });
        m.mockups['mockups/web/s1.svg'] = svgOf(64, 48, { pad: each });
        m.mockups['mockups/web/s1.ico'] = icoOf(flatPng(32, 32, { alpha: true, pad: each }), 32, 32);
        for (const path of ['mockups/web/s1.png', 'mockups/web/s1.webp', 'mockups/web/s1.svg']) m.design.mockups.push({ path, kind: 'image', screens: ['S1'], external_urls: [] });
      });
    const many = variantOf(model, (m) => {
      for (let i = 0; i < 60; i++) m.mockups[`mockups/web/pages/p${String(i).padStart(3, '0')}.html`] = `<!doctype html><title>${i}</title>\n`;
    });
    const heads = [];
    const cases = [
      { name: 'sixty more files under design_tree_max_files 50', model: many, before: async () => { await changePolicy(fx.engine, p.id, { design_tree_max_files: 50 }); heads.push(refOid(p.repo.path, p.repo.ref)); } },
      { name: 'four binary files of about 100 KiB', model: binaries(100 * KIB), before: async () => changePolicy(fx.engine, p.id, { design_tree_max_bytes: MIB }) },
      { name: 'four binary files of about 300 KiB under design_tree_max_bytes 1 MiB', model: binaries(300 * KIB), before: async () => heads.push(refOid(p.repo.path, p.repo.ref)) },
    ];
    const out = await checkSession(fx, p.id, cases);
    const [tooMany, admitted, tooBig] = out.saves.map((s) => s.res);
    assert.equal(tooMany.status, 413, `too many files: 413 (${tooMany.status} ${tooMany.text?.slice(0, 400)})`);
    assert.equal(tooMany.body?.code, 'design_tree_too_large', 'design_tree_too_large (D7 A.6)');
    assert.ok(JSON.stringify(tooMany.body).includes('design_tree_max_files'), `naming design_tree_max_files (${tooMany.text?.slice(0, 400)})`);
    assert.equal(admitted.status, 200, `binary files of the four formats under the bounds: admitted (${admitted.status} ${admitted.text?.slice(0, 400)})`);
    assert.ok(checkOf(admitted), 'and checked');
    assert.equal(tooBig.status, 413, `the same files past design_tree_max_bytes: 413, binary bytes counted (${tooBig.status} ${tooBig.text?.slice(0, 400)})`);
    assert.equal(tooBig.body?.code, 'design_tree_too_large', 'design_tree_too_large');
    assert.ok(JSON.stringify(tooBig.body).includes('design_tree_max_bytes'), `naming design_tree_max_bytes (${tooBig.text?.slice(0, 400)})`);
    assert.equal(refOid(p.repo.path, p.repo.ref), heads[1], 'the refused save committed nothing');
    await postCloseRaw(fx, p.id, out.run.id, { refuse: true });
  });
});
