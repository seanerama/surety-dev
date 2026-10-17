// The design's figures of the pace read (D7 §13; M6 build spec §10; SEAM.md
// §489): per project, per Designer session, per UI stage, per preview, per
// review and per asset approval, each from the recorded observation it
// declares; a figure not recorded is `{"unknown": "<reason>"}`, never zero
// and never null. A read.

import type { Database } from 'better-sqlite3';

import { parseJson } from '../store/transitions/common.js';
import { designPolicyOf } from './policy.js';
import { nowMs } from '../clock.js';

type Unknown = { unknown: string };
type Figure<T> = T | Unknown;
const unknown = (reason: string): Unknown => ({ unknown: reason });

function seconds(a: string | null | undefined, b: string | null | undefined, what: [string, string]): Figure<number> {
  const x = typeof a === 'string' ? Date.parse(a) : NaN;
  const y = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isNaN(x)) return unknown(`${what[0]} was not recorded`);
  if (Number.isNaN(y)) return unknown(`${what[1]} was not recorded`);
  if (y < x) return unknown('clock_stepped_back');
  return (y - x) / 1000;
}

const firstAt = (db: Database, type: string, project: string, after = 0): { at: string; seq: number } | null =>
  (db.prepare(`SELECT "created_at" AS "at", "seq" FROM "events" WHERE "type" = ? AND json_extract("subject", '$.project') = ? AND "seq" > ? ORDER BY "seq" LIMIT 1`).get(type, project, after) as { at: string; seq: number } | undefined) ?? null;

// The union of intervals, seconds (overlaps once).
function union(xs: [number, number][]): number {
  const s = xs.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of s) {
    if (cur === null || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total / 1000;
}

export function designPace(db: Database, project: string): Record<string, unknown> {
  const policy = designPolicyOf(db, project);
  const spec = firstAt(db, 'baseline.spec_approved', project);
  const approved = firstAt(db, 'design.approved', project);
  const ready = firstAt(db, 'design.ready', project);
  const effective = db.prepare('SELECT "slot", "variant", "source" FROM "design_effective_assets" WHERE "project" = ?').all(project) as { slot: string; variant: string; source: string }[];
  const bySource: Record<string, number> = {};
  for (const e of effective) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  const bound = new Set((db.prepare('SELECT DISTINCT "slot" FROM "asset_bindings" WHERE "project" = ? AND "superseded_by" IS NULL').all(project) as { slot: string }[]).map((r) => r.slot));
  const slots = [...new Set(effective.map((e) => e.slot))];
  const rev = db.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as { id: string } | undefined;
  // The engine's record of what is not checkable yet (D7 §7.2, §7.3; A.3
  // design_native_obligations), per target, of the latest approved
  // revision: never the design's own human-test list, which may omit one.
  const notCheckable: Record<string, number> = {};
  if (rev) {
    for (const o of db.prepare('SELECT "target", COUNT(*) AS n FROM "design_native_obligations" WHERE "design_revision" = ? GROUP BY "target" ORDER BY "target"').all(rev.id) as { target: string; n: number }[]) notCheckable[o.target] = o.n;
  }
  const projectFigures = {
    policy,
    spec_approved_to_design_approved: spec && approved ? seconds(spec.at, approved.at, ['the specification approved', 'the design approved']) : unknown(spec ? 'no design was approved' : 'no specification was approved'),
    design_approved_to_ready: approved && ready ? seconds(approved.at, ready.at, ['the design approved', 'the design ready']) : unknown(approved ? 'the design is not ready' : 'no design was approved'),
    slots_by_source: effective.length > 0 ? bySource : unknown('the project has no effective asset set'),
    unbound_slots: slots.length > 0 ? slots.filter((s) => !bound.has(s)).length : unknown('the project has no effective asset set'),
    not_checkable_yet: rev ? notCheckable : unknown('no design was approved'),
  };

  // ---- per Designer session ------------------------------------------------------------------
  const runs = db.prepare(`SELECT "id", "created_at", "started_at", "finished_at", "session_notes" FROM "runs" WHERE "project" = ? AND "kind" = 'session' AND "role" = 'designer' ORDER BY "seq"`).all(project) as {
    id: string;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    session_notes: string | null;
  }[];
  const designer_sessions = runs.map((r) => {
    const turns = (db.prepare('SELECT COUNT(*) AS n FROM "turns" WHERE "run" = ?').get(r.id) as { n: number }).n;
    const ledger = db.prepare('SELECT "billable_in", "cached_in", "out", "usage_complete" FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL').all(r.id) as {
      billable_in: number | null;
      cached_in: number | null;
      out: number | null;
      usage_complete: number;
    }[];
    // Unknown when any turn's usage was not recorded whole (SEAM.md §540;
    // the slice-46 review's S2), never the sum of the rows that were.
    const tok = (c: 'billable_in' | 'cached_in' | 'out'): Figure<number> =>
      ledger.length === 0
        ? unknown('the session has no ledger row')
        : ledger.some((l) => l.usage_complete !== 1)
          ? unknown("a turn's usage was not recorded whole (usage_complete 0)")
          : ledger.some((l) => l[c] === null)
            ? unknown(`a ledger row has no ${c}`)
            : ledger.reduce((n, l) => n + (l[c] as number), 0);
    const check = db.prepare('SELECT "tree_revision" FROM "design_checks" WHERE "run" = ? ORDER BY rowid DESC LIMIT 1').get(r.id) as { tree_revision: string } | undefined;
    const screens: Record<string, number> = {};
    const dsg = db.prepare('SELECT "content" FROM "design_revisions" WHERE "run" = ? ORDER BY rowid DESC LIMIT 1').get(r.id) as { content: string | null } | undefined;
    for (const s of parseJson<{ screens?: { screens?: { target: string }[] } }>(dsg?.content ?? null)?.screens?.screens ?? []) screens[s.target] = (screens[s.target] ?? 0) + 1;
    const start = Date.parse(r.started_at ?? r.created_at);
    const end = r.finished_at ? Date.parse(r.finished_at) : Number.POSITIVE_INFINITY;
    const beside = (
      db.prepare(`SELECT "created_at", "finished_at" FROM "runs" WHERE "project" = ? AND "kind" = 'one_shot' ORDER BY "seq"`).all(project) as { created_at: string; finished_at: string | null }[]
    ).filter((o) => Date.parse(o.created_at) < end && (o.finished_at === null || Date.parse(o.finished_at) > start)).length;
    return {
      run: r.id,
      mode: parseJson<{ mode?: string }>(r.session_notes)?.mode ?? 'design',
      turns,
      seconds: seconds(r.started_at ?? r.created_at, r.finished_at, ['the session started', 'the session ended']),
      tokens: { billable: tok('billable_in'), cached_in: tok('cached_in'), output: tok('out') },
      screens_by_target: dsg ? screens : check ? unknown('the session proposed no design') : unknown('the session saved no design'),
      one_shots_beside: beside,
    };
  });

  // ---- per UI stage --------------------------------------------------------------------------
  const items = db.prepare(`SELECT "id", "created_at", "subject", "depends_on", "held_intervals" FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build' ORDER BY "seq"`).all(project) as {
    id: string;
    created_at: string;
    subject: string;
    depends_on: string | null;
    held_intervals: string | null;
  }[];
  // A decision's open interval (D6 §7.6): from its raise to its answer, its
  // consumption, or the `decision.invalidated` event that closed it (the
  // engine closes a design_due when nothing it names is held: counted,
  // never dropped). An open decision has no interval yet; a closed one with
  // no recorded end is unknown.
  const intervalsOf = (kind: string): { closed: [number, number][]; open: number[] } | Unknown => {
    const ds = db.prepare(`SELECT "id", "raised_at", "consumed_at", "answer", "status" FROM "decisions" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"`).all(project, kind) as {
      id: string;
      raised_at: string;
      consumed_at: string | null;
      answer: string | null;
      status: string;
    }[];
    const closed: [number, number][] = [];
    const open: number[] = [];
    for (const d of ds) {
      const a = Date.parse(d.raised_at);
      if (Number.isNaN(a)) return unknown(`a ${kind}'s raise was not recorded`);
      if (d.status === 'open') {
        open.push(a);
        continue;
      }
      const end =
        parseJson<{ at?: string }>(d.answer)?.at ??
        d.consumed_at ??
        (db.prepare(`SELECT "created_at" FROM "events" WHERE "type" = 'decision.invalidated' AND json_extract("subject", '$.decision') = ? ORDER BY "seq" LIMIT 1`).get(d.id) as { created_at: string } | undefined)?.created_at ??
        null;
      if (end === null) return unknown(`a ${kind} closed with no recorded end`);
      const b = Date.parse(end);
      if (Number.isNaN(b)) return unknown(`a ${kind}'s end was not recorded`);
      closed.push([a, b]);
    }
    return { closed, open };
  };
  const kinds = { design_due: intervalsOf('design_due'), design_approval: intervalsOf('design_approval') };
  const now = nowMs();
  // The human wait of a UI stage (D6 §7.6, D7 §8.5; the slice-46 review's
  // S1): each kind's decisions counted only while they held this stage,
  // that is within its design_pending and design_stale holds, each cut to
  // the stage's lifetime (its creation to its completion or cancellation,
  // else now); and the union of both kinds, the overlap counted once. A
  // decision still open while the stage is held makes the figure unknown.
  const humanWait = (holds: [number, number][]): Record<string, Figure<number>> => {
    const within = (iv: [number, number][]): [number, number][] => iv.flatMap(([a, b]) => holds.map(([x, y]): [number, number] => [Math.max(a, x), Math.min(b, y)]).filter(([p, q]) => q > p));
    const out: Record<string, Figure<number>> = {};
    const all: [number, number][] = [];
    let unknownOf: Unknown | null = null;
    for (const [k, v] of Object.entries(kinds)) {
      if ('unknown' in v) {
        out[k] = v;
        unknownOf ??= v;
        continue;
      }
      if (v.open.some((a) => holds.some(([, y]) => a < y))) {
        out[k] = unknown(`a ${k} is still open while the stage is held`);
        unknownOf ??= out[k] as Unknown;
        continue;
      }
      const pieces = within(v.closed);
      out[k] = union(pieces);
      all.push(...pieces);
    }
    out.union = unknownOf ?? union(all);
    return out;
  };
  const endOf = (w: { id: string }): number => {
    const e = db.prepare(`SELECT "created_at" FROM "events" WHERE "type" IN ('work.complete', 'work.cancelled') AND json_extract("subject", '$.work_item') = ? ORDER BY "seq" LIMIT 1`).get(w.id) as { created_at: string } | undefined;
    const t = e ? Date.parse(e.created_at) : NaN;
    return Number.isNaN(t) ? now : t;
  };
  const designHolds = (w: { id: string; created_at: string }, intervals: { reason: string; from?: string; to?: string | null; start?: string; end?: string | null }[]): [number, number][] => {
    const born = Date.parse(w.created_at);
    const end = endOf(w);
    return intervals
      .filter((i) => i.reason === 'design_pending' || i.reason === 'design_stale')
      .map((i): [number, number] => {
        const a = Date.parse(i.from ?? i.start ?? '');
        const to = i.to ?? i.end ?? null;
        const b = to === null ? end : Date.parse(to);
        return [Math.max(Number.isNaN(a) ? born : a, born), Math.min(Number.isNaN(b) ? end : b, end)];
      })
      .filter(([a, b]) => b > a);
  };
  const ui_stages = items
    .filter((w) => (parseJson<{ milestone?: string }[]>(w.depends_on) ?? []).some((d) => d && d.milestone === 'design_ready'))
    .map((w) => {
      const intervals = parseJson<{ reason: string; from?: string; to?: string | null; start?: string; end?: string | null }[]>(w.held_intervals) ?? [];
      const held = (reason: string): Figure<number> => {
        const of = intervals.filter((i) => i.reason === reason);
        let total = 0;
        for (const i of of) {
          const s = seconds(i.from ?? i.start, i.to ?? i.end, ['the hold began', 'the hold ended']);
          if (typeof s !== 'number') return s;
          total += s;
        }
        return total;
      };
      return {
        stage: parseJson<{ stage?: string }>(w.subject)?.stage ?? unknown('the work item names no stage'),
        work_item: w.id,
        design_pending_seconds: held('design_pending'),
        design_stale_seconds: held('design_stale'),
        human_wait: humanWait(designHolds(w, intervals)),
      };
    });

  // ---- per preview -----------------------------------------------------------------------------
  const previews = (
    db.prepare('SELECT "id", "created_at", "generation", "status", "deployed_at", "torn_down_at", "memory_peak" FROM "design_previews" WHERE "project" = ? ORDER BY rowid').all(project) as {
      id: string;
      created_at: string;
      generation: number;
      status: string;
      deployed_at: string | null;
      torn_down_at: string | null;
      memory_peak: number | null;
    }[]
  ).map((p) => ({
    preview: p.id,
    generation: p.generation,
    status: p.status,
    deploy_seconds: p.deployed_at ? seconds(p.created_at, p.deployed_at, ['the preview asked for', 'the preview deployed']) : unknown(`the preview was not deployed (${p.status})`),
    memory_peak: p.memory_peak ?? unknown('the preview domain\'s memory.peak was not read before its removal'),
  }));

  // ---- per review -----------------------------------------------------------------------------
  const reviews = (
    db
      .prepare(
        `SELECT r."id", r."created_at", r."subject", r."verdicts", r."run", r."review_blob", x."created_at" AS "run_at",
           (SELECT e."created_at" FROM "events" e WHERE e."type" = 'design.review_recorded' AND json_extract(e."subject", '$.design_review') = r."id" ORDER BY e."seq" LIMIT 1) AS "recorded_at"
         FROM "design_reviews" r LEFT JOIN "runs" x ON x."id" = r."run" WHERE r."project" = ? ORDER BY r.rowid`,
      )
      .all(project) as {
      id: string;
      created_at: string;
      review_blob: string | null;
      recorded_at: string | null;
      subject: string;
      verdicts: string;
      run: string | null;
      run_at: string | null;
    }[]
  ).map((r) => {
    const subject = parseJson<{ kind?: string; candidate?: string }>(r.subject) ?? {};
    const verdicts = parseJson<{ target: string; verdict: string; deltas?: { kind?: string }[] }[]>(r.verdicts) ?? [];
    const deltas: Record<string, number> = {};
    for (const v of verdicts) for (const d of v.deltas ?? []) deltas[`${v.target}:${d.kind ?? 'unspecified'}`] = (deltas[`${v.target}:${d.kind ?? 'unspecified'}`] ?? 0) + 1;
    const evidence: Record<string, number> = {};
    for (const e of db.prepare('SELECT "provenance" FROM "design_evidence" WHERE "review" = ?').all(r.id) as { provenance: string }[]) evidence[e.provenance] = (evidence[e.provenance] ?? 0) + 1;
    return {
      review: r.id,
      subject: subject.kind === 'candidate' && subject.candidate ? `candidate:${subject.candidate}` : (subject.kind ?? unknown('the review names no subject')),
      // To the review's record (`design.review_recorded`): an owner-invoked
      // review's row is made at its opening, so its time is unknown until
      // its review is recorded.
      seconds: r.review_blob === null || r.recorded_at === null ? unknown('the review was not recorded') : seconds(r.run_at, r.recorded_at, ['the review session opened', 'the review recorded']),
      deltas,
      // Evidence by provenance; a review that recorded none is unknown, never zero.
      evidence: Object.keys(evidence).length > 0 ? evidence : unknown('the review recorded no evidence'),
    };
  });

  // ---- per asset approval ------------------------------------------------------------------------
  const asset_approvals = (
    db.prepare(`SELECT "id", "created_at", "subject" FROM "events" WHERE "type" = 'design.assets_approved' AND json_extract("subject", '$.project') = ? ORDER BY "seq"`).all(project) as { id: string; created_at: string; subject: string }[]
  ).map((e) => {
    const rev = parseJson<{ design_revision?: string }>(e.subject)?.design_revision ?? null;
    const fix = db.prepare(`SELECT "id", "status" FROM "work_items" WHERE "project" = ? AND "kind" = 'fix' AND "trigger_source" = 'asset_updated' AND "trigger_id" LIKE ? ORDER BY "seq" DESC LIMIT 1`).get(project, `${rev ?? ''}:%`) as
      | { id: string; status: string }
      | undefined;
    const integrated = fix ? (db.prepare(`SELECT "created_at" FROM "events" WHERE "type" = 'work.integrated' AND json_extract("subject", '$.work_item') = ? ORDER BY "seq" LIMIT 1`).get(fix.id) as { created_at: string } | undefined) : undefined;
    return {
      design_revision: rev ?? unknown('the approval names no revision'),
      approval_to_integration: !fix ? unknown('no asset_updated work was registered (no stage carried the slot)') : integrated ? seconds(e.created_at, integrated.created_at, ['the assets approved', 'the asset_updated work integrated']) : unknown('the asset_updated work is not integrated'),
    };
  });

  return { project: projectFigures, designer_sessions, ui_stages, previews, reviews, asset_approvals };
}
