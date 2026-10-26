import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';
import {AssistantService,ToolGateway} from '../../dist/assistant/service.js';
const actor={actor_kind:'human',actor_id:null,request_id:'claim-request'};
function setup(t){const home=mkdtempSync('/tmp/asst-act-');t.after(()=>rmSync(home,{recursive:true,force:true}));return {home,service:new AssistantService(home,true,async()=>({decisions:[],projects:[]}), 'token-test')};}
const payload={name:'Puzzle',tier:'T2',dev_repo_path:'/tmp/puzzle-test',idea:'Puzzle game for families.'};
async function ask(service,text='Create a project',project=null,intent_id='owner_1'){const id=service.create({}).conversation.id;await service.message(id,{intent_id,text,context:{project,screen:'home'}},actor);return id;}
test('create claim and each step are durably one-use, exact payload bound, reports cannot be rewritten',async t=>{
 const {service,home}=setup(t);const id=await ask(service);const claim={intent_id:'owner_1',kind:'create_app',payload};const first=service.claimAction(id,claim,actor);assert.equal(first.execute,true);assert.equal(service.claimAction(id,claim,actor).execute,false);assert.throws(()=>service.claimAction(id,{...claim,payload:{...payload,tier:'T3'}},actor),e=>e.code==='assistant_intent_conflict');
 const a=first.receipt.id;const body={step:'create',request:{body:{idea:payload.idea,dev_repo_path:payload.dev_repo_path,tier:payload.tier,name:payload.name}}};assert.equal(service.actionStep(id,a,body).execute,true);assert.equal(service.actionStep(id,a,body).execute,false);assert.throws(()=>service.actionStep(id,a,{step:'create',request:{body:{...payload,name:'Changed'}}}),e=>e.code==='assistant_scope_refused');
 const report={step:'create',outcome:'unknown',request_id:'mutation-req'};assert.equal(service.actionResult(id,a,report).receipt.status,'unknown');assert.throws(()=>service.actionResult(id,a,{...report,outcome:'refused'}),e=>e.code==='assistant_intent_conflict');
 const restarted=new AssistantService(home,true,async()=>({}), 'token-test');assert.equal(restarted.claimAction(id,claim,actor).execute,false);assert.equal(restarted.actionStep(id,a,body).execute,false);assert.equal(restarted.listActions(id).receipts[0].steps[0].client_report.request_id,'mutation-req');
});
test('different message, conversation and deletion cannot escape an unknown target claim',async t=>{
 const {service}=setup(t);const one=await ask(service);const a=service.claimAction(one,{intent_id:'owner_1',kind:'create_app',payload},actor);service.actionStep(one,a.receipt.id,{step:'create',request:{body:payload}});assert.throws(()=>service.delete(one),e=>e.code==='assistant_action_unsettled');assert.equal(service.allActions().receipts[0].id,a.receipt.id);
 const two=await ask(service,'Create an app',null,'owner_2');assert.throws(()=>service.claimAction(two,{intent_id:'owner_2',kind:'create_app',payload},actor),e=>e.code==='assistant_target_claimed');
});
test('only explicit owner requests can claim actions, planning stays on bound project',async t=>{
 const {service}=setup(t);const read=await ask(service,'What needs attention?');assert.throws(()=>service.claimAction(read,{intent_id:'owner_1',kind:'create_app',payload},actor),e=>e.code==='assistant_authorization_refused');
 const named=await ask(service,'Start planning for OtherApp','p_one');assert.throws(()=>service.claimAction(named,{intent_id:'owner_1',kind:'start_planning',payload:{project:'p_one'}},actor),e=>e.code==='assistant_authorization_refused');
 const id=await ask(service,'Start planning','p_one');assert.throws(()=>service.claimAction(id,{intent_id:'owner_1',kind:'start_planning',payload:{project:'p_other'}},actor),e=>e.code==='assistant_scope_refused');
 const a=service.claimAction(id,{intent_id:'owner_1',kind:'start_planning',payload:{project:'p_one'}},actor).receipt.id;assert.throws(()=>service.actionStep(id,a,{step:'approve',request:{project:'p_one',body:{}}}),e=>e.code==='assistant_tool_refused');assert.throws(()=>service.actionStep(id,a,{step:'open',request:{project:'p_one',body:{role:'vision',model:'expensive'}}}),e=>e.code==='invalid_value');
 service.actionStep(id,a,{step:'resume',request:{project:'p_one',body:{}}});assert.throws(()=>service.actionStep(id,a,{step:'open',request:{project:'p_one',body:{role:'vision'}}}),e=>e.code==='assistant_action_unsettled');
 service.actionResult(id,a,{step:'resume',outcome:'committed',project:'p_one'});assert.equal(service.actionStep(id,a,{step:'open',request:{project:'p_one',body:{role:'vision'}}}).execute,true);assert.throws(()=>service.actionResult(id,a,{step:'open',outcome:'committed',project:'p_other'}),e=>e.code==='assistant_scope_refused');
});
test('gateway rejects unknown tool, extra fields and candidate retargeting without a read',async()=>{
 let count=0;const g=new ToolGateway(async()=>{count++;return {};},{project:'p_one',screen:'checks',candidate:'c_one'},'');
 await assert.rejects(g.invoke('shell','candidate.read',{project:'p_one',candidate:'c_one'},'/'),e=>e.code==='assistant_tool_refused');await assert.rejects(g.invoke('gate','candidate.read',{project:'p_one',candidate:'c_two'},'/'),e=>e.code==='assistant_scope_refused');await assert.rejects(g.invoke('gate','candidate.read',{project:'p_one',candidate:'c_one',url:'https://example.com'},'/'),e=>e.code==='invalid_value');assert.equal(count,0);
});
