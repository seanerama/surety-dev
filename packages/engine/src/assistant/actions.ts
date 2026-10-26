// Durable assistant-side duplicate protection around the ordinary UI action
// contracts. Claims are not engine mutations or evidence of their completion.
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../ids.js';
import { Refusal } from '../refusal.js';
import type { AssistantMessage } from './contract.js';
import type { Actor } from '../store/transitions/tx.js';
type Obj = Record<string, any>;
export interface ActionReceipt {
 id: string; conversation: string; intent_id: string; kind: 'create_app'|'start_planning'; payload: Obj;
 target: string; status: 'claimed'|'partial'|'completed'|'refused'|'unknown'; created_at: string; updated_at: string;
 actor: { kind: 'human'; request_id: string|null; source:'assistant_panel' }; steps: {step:string;request:Obj;claimed_at:string;client_report?:Obj}[];
}
const fail=(code:string,reason:string,status=409)=>new Refusal(status,code,reason,'Inspect current engine state; an unknown action must not be replayed.');
const fields=(v:unknown,keys:string[]):Obj=>{ if(!v||typeof v!=='object'||Array.isArray(v))throw fail('invalid_value','Expected an object.',400);for(const k of Object.keys(v))if(!keys.includes(k))throw fail('invalid_value','Unknown assistant action field.',400);return v as Obj;};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export function actionKind(text:string):ActionReceipt['kind']|null {
 if(/^\s*(?:please\s+)?(?:create|start|make)\s+(?:a\s+|an\s+|new\s+|a new\s+)?(?:app|project)\b/i.test(text))return 'create_app';
 if(/^\s*(?:please\s+)?(?:start|begin)\s+(?:planning|vision)(?:\s+for\s+(?:this|the current)\s+(?:app|project))?[.!]?\s*$/i.test(text))return 'start_planning';
 return null;
}
export class ActionStore {
 private readonly dir:string;
 constructor(home:string,private readonly safe:<T>(v:T)=>T){this.dir=join(home,'assistant-actions');}
 private path(action:string){if(!/^aa_[A-Z0-9]{26}$/.test(action))throw fail('invalid_value','Invalid action identifier.',400);return join(this.dir,action+'.json');}
 private all():ActionReceipt[]{return existsSync(this.dir)?readdirSync(this.dir).filter(n=>/^aa_[A-Z0-9]{26}\.json$/.test(n)).map(n=>this.safe(JSON.parse(readFileSync(join(this.dir,n),'utf8')))):[];}
 private save(receipt:ActionReceipt){mkdirSync(this.dir,{recursive:true,mode:0o700});const path=this.path(receipt.id),temp=path+'.tmp';writeFileSync(temp,JSON.stringify(this.safe(receipt)),{mode:0o600});const f=openSync(temp,'r');try{fsyncSync(f);}finally{closeSync(f);}renameSync(temp,path);const d=openSync(this.dir,'r');try{fsyncSync(d);}finally{closeSync(d);}}
 list(conversation?:string){return {receipts:this.all().filter(a=>conversation===undefined||a.conversation===conversation)};}
 get(conversation:string,action:string){const p=this.path(action);if(!existsSync(p))throw fail('not_found','Action receipt does not exist.',404);const a=this.safe(JSON.parse(readFileSync(p,'utf8'))) as ActionReceipt;if(a.conversation!==conversation)throw fail('not_found','Action receipt does not belong to this conversation.',404);return a;}
 claim(conversation:string,message:AssistantMessage,value:unknown,actor:Actor){
  const b=fields(value,['intent_id','kind','payload']);if(!id(b.intent_id)||b.intent_id!==message.intent_id||message.role!=='user'||actionKind(message.text)!==b.kind)throw fail('assistant_authorization_refused','This action needs a matching explicit owner request.',403);
  let payload:Obj;let target:string;
  if(b.kind==='create_app'){
   const p=fields(b.payload,['name','tier','dev_repo_path','idea']);
   if(typeof p.name!=='string'||!p.name.trim()||p.name.length>120||/[\x00-\x1f]/.test(p.name)||typeof p.idea!=='string'||!p.idea.trim()||p.idea.length>20000||!['T1','T2','T3'].includes(p.tier)||typeof p.dev_repo_path!=='string'||!p.dev_repo_path.startsWith('/')||p.dev_repo_path.length>1024||/[\x00-\x1f]/.test(p.dev_repo_path))throw fail('invalid_value','Create requires a name, brief, tier and absolute new folder path.',400);
   payload={name:p.name,tier:p.tier,dev_repo_path:p.dev_repo_path,idea:p.idea};target='create:'+p.dev_repo_path;
  }else if(b.kind==='start_planning'){
   const p=fields(b.payload,['project']);if(!id(p.project)||p.project!==message.context.project)throw fail('assistant_scope_refused','Planning must target the app bound to the owner request.',403);payload={project:p.project};target='planning:'+p.project;
  }else throw fail('assistant_tool_refused','That action is not allowed.',403);
  if(JSON.stringify(this.safe(payload))!==JSON.stringify(payload))throw fail('assistant_sensitive_input','The action payload contains a secret; it was not claimed.',400);
  const all=this.all(),existing=all.find(a=>a.conversation===conversation&&a.intent_id===b.intent_id);
  if(existing){if(existing.kind!==b.kind||digest(existing.payload)!==digest(payload))throw fail('assistant_intent_conflict','This owner intent already names a different action payload.');return {receipt:existing,execute:false};}
  const prior=all.find(a=>a.target===target&&a.status!=='refused');if(prior)throw fail('assistant_target_claimed','An assistant action already claimed this target. Inspect its receipt and current engine state; do not create another intent to replay it.');
  if(all.length>=500)throw fail('assistant_limit','The durable action receipt limit has been reached.',429);
  const now=new Date().toISOString();const receipt:ActionReceipt={id:newId('aa_'),conversation,intent_id:b.intent_id,kind:b.kind,payload,target,status:'claimed',created_at:now,updated_at:now,actor:{kind:'human',request_id:actor.request_id,source:'assistant_panel'},steps:[]};this.save(receipt);return {receipt,execute:true};
 }
 step(conversation:string,action:string,value:unknown){
  const b=fields(value,['step','request']),a=this.get(conversation,action);const r=fields(b.request,['project','run','body']);
  if(!['create','resume','open','turn'].includes(b.step))throw fail('assistant_tool_refused','Unsupported action step.',403);
  if(a.kind==='create_app') {if(b.step!=='create'||r.project!==undefined||r.run!==undefined||digest(r.body)!==digest(a.payload))throw fail('assistant_scope_refused','Create step differs from its claimed payload.',403);}
  else {
   if(r.project!==a.payload.project||b.step==='create')throw fail('assistant_scope_refused','Planning step differs from its bound project.',403);
   if(b.step==='resume'){fields(r.body,[]);if(r.run!==undefined)throw fail('invalid_value','Resume cannot name a run.',400);}
   if(b.step==='open'){const body=fields(r.body,['role']);if(body.role!=='vision'||r.run!==undefined)throw fail('assistant_tool_refused','Only the default Vision session may be opened.',403);}
   if(b.step==='turn'){const body=fields(r.body,['text','expected_generation']);if(!id(r.run)||typeof body.text!=='string'||body.text !== 'Start planning (sent automatically by the console when I clicked Start planning). Read the saved app description in approved/idea.md. Briefly summarize your understanding, then begin the Vision conversation with the most useful clarifying questions. Do not ask me to repeat the description, invent my preferences, or treat assumptions as decisions. If the saved description is unavailable, explain that instead.'||body.text.length>1000||!Number.isInteger(body.expected_generation)||body.expected_generation<0)throw fail('assistant_tool_refused','Only the shared saved-brief opening turn with a current generation is permitted.',403);}
  }
  const old=a.steps.find(s=>s.step===b.step);if(old){if(digest(old.request)!==digest(r))throw fail('assistant_intent_conflict','A step already claimed a different payload.');return {receipt:a,execute:false};}
  if(['completed','unknown','refused'].includes(a.status)||a.steps.some(s=>!s.client_report||s.client_report.outcome==='unknown'||s.client_report.outcome==='refused'))throw fail('assistant_action_unsettled','A previous step has no successful receipt; automatic continuation is refused.');
  if(a.steps.some(s=>s.step==='turn')||(b.step==='resume'&&a.steps.length>0)||(b.step==='open'&&a.steps.some(s=>s.step!=='resume')))throw fail('assistant_step_order','This planning step is out of order.');
  a.steps.push({step:b.step,request:r,claimed_at:new Date().toISOString()});a.status='unknown';a.updated_at=new Date().toISOString();this.save(a);return {receipt:a,execute:true};
 }
 result(conversation:string,action:string,value:unknown){
  const b=fields(value,['step','outcome','project','run','request_id']);if(!['committed','admitted','refused','unknown'].includes(b.outcome))throw fail('invalid_value','Unsupported client outcome.',400);for(const k of ['project','run','request_id'])if(b[k]!==undefined&&!id(b[k]))throw fail('invalid_value',`Invalid ${k}.`,400);
  const a=this.get(conversation,action),step=a.steps.find(s=>s.step===b.step);if(!step)throw fail('assistant_step_missing','The step was not claimed.');
  if(step.client_report){if(digest(step.client_report)!==digest(b))throw fail('assistant_intent_conflict','A step report cannot be overwritten.');return {receipt:a};}
  if(a.kind==='start_planning'&&b.project!==undefined&&b.project!==a.payload.project)throw fail('assistant_scope_refused','Reported project differs from the bound project.',403);
  step.client_report=b;a.status=b.outcome==='unknown'?'unknown':b.outcome==='refused'?'refused':b.step==='create'||b.step==='turn'?'completed':'partial';a.updated_at=new Date().toISOString();this.save(a);return {receipt:a};
 }
}
