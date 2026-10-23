const fs=require('fs');
const [json, ticks]=process.argv.slice(2);
const j=JSON.parse(fs.readFileSync(json,'utf8'));
const rows=[];
for (const m of j.marks) rows.push([m.at,'TEST',m.what]);
for (const l of fs.readFileSync(ticks,'utf8').split('\n').filter(Boolean)) { const i=l.indexOf(' '); rows.push([l.slice(0,i),'ENGINE',l.slice(i+1)]); }
const ops={};
for (const e of j.trace.journal) { ops[e.operation]=e.journal_kind; rows.push([e.created_at,'JOURNAL',e.journal_kind+' '+e.event_kind]); }
for (const a of j.trace.attempts) { rows.push([a.started_at,'ATTEMPT',(ops[a.operation]||'?')+' #'+a.attempt_number+' started']); for (const r of JSON.parse(a.reconciliation_reads||'[]')) rows.push([r.at,'PROBE',(ops[a.operation]||'?')+' #'+a.attempt_number+' '+r.read+' -> '+r.result]); }
for (const e of j.trace.events) if (['engine.tick','run.ended','work.claimed','run.created'].includes(e.type)) rows.push([e.at,'EVENT',e.type]);
rows.sort((a,b)=>a[0].localeCompare(b[0]));
const s=rows.findIndex(r=>r[2]==='commit_reconciled_reached');
for (const r of rows.slice(Math.max(0,s-2))) console.log(r.join('  '));
console.log('observed', JSON.stringify(j.observed));
