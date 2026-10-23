const j=require(process.argv[2]);
const rows=[];
for (const m of j.marks) rows.push([m.at,"TEST",m.what]);
for (const e of j.trace.journal) rows.push([e.created_at,"JOURNAL",e.journal_kind+" "+e.event_kind+" op"+e.operation.slice(-4)]);
for (const a of j.trace.attempts) { for (const x of JSON.parse(a.timeline)) rows.push([x.at,"ATTEMPT",a.operation.slice(-4)+" #"+a.attempt_number+" "+x.event]); for (const r of JSON.parse(a.reconciliation_reads||"[]")) rows.push([r.at||"?","READ",a.operation.slice(-4)+" #"+a.attempt_number+" "+JSON.stringify(r)]); }
for (const e of j.trace.events) { if (e.type==="engine.tick") rows.push([e.at,"TICK-END",e.payload]); else if (e.type==="scheduler.tick_requested") rows.push([e.at,"TICK-REQ",(JSON.parse(e.payload).cause||"")]); else rows.push([e.at,"EVENT",e.type+" "+(e.subject||"").slice(0,90)]); }
rows.sort((a,b)=>a[0].localeCompare(b[0]));
const s=rows.findIndex(r=>r[2]==="commit_reconciled_released");
for (const r of rows.slice(Math.max(0,s-1))) if (r[1]!=="TICK-REQ" || r[2]!=="api") console.log(r.join("  ").slice(0,220));
console.log("observed", JSON.stringify(j.observed), "barriers", JSON.stringify(j.barriers));
