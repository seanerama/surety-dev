const fs=require('fs');
const files=process.argv.slice(2);
const ms=(a,b)=>a&&b?(Date.parse(a)-Date.parse(b)):null;
console.log(['run','result','T_c end-armed(ms)','T_c dispatched','refIntended-armed','refAttempt-armed','kill-armed','probe-kill','reached-armed'].join('\t'));
for (const f of files) {
  const j=JSON.parse(fs.readFileSync(f,'utf8'));
  const mark=(w)=>j.marks.find(m=>m.what===w)?.at;
  const rel=mark('commit_reconciled_released'), armed=mark('tick_running_armed'), reached=mark('tick_running_reached');
  const ticks=j.trace.events.filter(e=>e.type==='engine.tick' && e.at>=rel);
  const tc=ticks[0];
  const ref=j.trace.journal.filter(e=>e.journal_kind==='ref_update');
  const intended=ref.find(e=>e.event_kind==='intended')?.created_at, amb=ref.find(e=>e.event_kind==='ambiguous')?.created_at;
  const att=j.trace.attempts.find(a=>ref[0]&&a.operation===ref[0].operation);
  const read=att?JSON.parse(att.reconciliation_reads||'[]')[0]?.at:null;
  const ok=JSON.stringify(j.observed)===JSON.stringify(['ambiguous','ambiguous',['ambiguous']]);
  console.log([f.split('/').pop().replace('.json',''), ok?'pass':'FAIL', ms(tc?.at,armed), tc?JSON.parse(tc.payload).dispatched:'-', ms(intended,armed), ms(att?.started_at,armed), ms(amb,armed), read?ms(read,amb):'-', ms(reached,armed)].join('\t'));
}
