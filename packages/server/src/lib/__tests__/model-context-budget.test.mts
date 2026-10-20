import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {DeepSeekHarness} from '@localapp/dsh-agent-runtime/harness';
afterEach(()=>vi.unstubAllGlobals());
const outputLimit=8192;
function response(text:string,inputTokens:number){return new Response(`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:inputTokens,completion_tokens:1,total_tokens:inputTokens+1}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});}
async function fixture(maxTokens:number|null=outputLimit){
 const base=path.resolve('../../tmp/model-context-budget');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'case-'));
 const harness=new DeepSeekHarness({ownerId:'fixture',root,capabilities:[],llmApiKey:'fixture-key',llmBaseUrl:'http://model.test/v1',llmModel:'qwen-context-test',protocol:'openai-completions',dshRoute:'custom',dshProfile:{api:'openai-completions',baseURL:'http://model.test/v1',models:[{id:'qwen-context-test',contextWindow:200000,...(maxTokens===null?{}:{maxTokens})}],retryPolicy:{mode:'normal',maxRetries:0}}});
 return {harness,close:async()=>{await harness.close();await fs.rm(root,{recursive:true,force:true})}};
}
it('keeps compaction output inside the selected 200K model output limit',async()=>{
 const requests:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
  const body=JSON.parse(String(init?.body));requests.push(body);
  const input=Math.ceil(JSON.stringify(body.messages).length/4);
  if((body.max_tokens??body.max_completion_tokens)>outputLimit)return new Response(JSON.stringify({error:{message:`max_tokens exceeds this model output limit ${outputLimit}`,code:'invalid_parameter_error'}}),{status:400,headers:{'Content-Type':'application/json'}});
  return response(body.messages.at(-1)?.content?.includes('compaction engine')?'Preserve the requested task and continue.':'completed',input);
 }));
 const f=await fixture();try{
  const input={sessionId:'bounded-summary',systemPrompt:'Continue the requested task.',tools:[]};
  const events:any[]=[];
  await f.harness.run('fixture',{...input,prompt:'alpha '.repeat(66000)},e=>events.push(e),new AbortController().signal);
  await f.harness.run('fixture',{...input,prompt:'beta '.repeat(40000)},e=>events.push(e),new AbortController().signal);
  await f.harness.run('fixture',{...input,prompt:'continue'},e=>events.push(e),new AbortController().signal);
  const summaries=requests.filter(r=>JSON.stringify(r.messages.at(-1)).includes('compaction engine'));
  expect(summaries.length).toBeGreaterThan(0);
  expect(summaries.every(r=>(r.max_tokens??r.max_completion_tokens)<=outputLimit)).toBe(true);
  expect(JSON.stringify(requests.at(-1).messages)).toContain('compacted-summary');
  expect(events.filter(e=>e.type==='error')).toEqual([]);
 }finally{await f.close()}
},20000);


it('compacts a large newly admitted turn before any oversized provider request',async()=>{
 const requests:any[]=[],events:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
  const body=JSON.parse(String(init?.body));requests.push(body);
  const input=Math.ceil(JSON.stringify(body.messages).length/4),output=body.max_tokens??body.max_completion_tokens??0;
  if(input+output>200000)return new Response(JSON.stringify({error:{message:'maximum context length is 200000 tokens',code:'context_length_exceeded'}}),{status:400,headers:{'Content-Type':'application/json'}});
  return response(JSON.stringify(body.messages.at(-1)).includes('compaction engine')?'Preserve the task and prior facts.':'completed',input);
 }));
 const f=await fixture();try{
  const input={sessionId:'large-followup',systemPrompt:'Continue the requested task.',tools:[]};
  await f.harness.run('fixture',{...input,prompt:'alpha '.repeat(78000)},e=>events.push(e),new AbortController().signal);
  await f.harness.run('fixture',{...input,prompt:'beta '.repeat(76000)},e=>events.push(e),new AbortController().signal);
  expect(requests.some(r=>JSON.stringify(r.messages.at(-1)).includes('compaction engine'))).toBe(true);
  expect(requests.every(r=>Math.ceil(JSON.stringify(r.messages).length/4)+(r.max_tokens??r.max_completion_tokens??0)<=200000)).toBe(true);
  expect(JSON.stringify(requests.at(-1).messages)).toContain('beta beta');
  expect(JSON.stringify(requests.at(-1).messages)).toContain('compacted-summary');
  expect(events.filter(e=>e.type==='error')).toEqual([]);
 }finally{await f.close()}
},20000);

it('rejects one oversized CJK input locally without deleting it or calling the provider',async()=>{
 const provider=vi.fn(async()=>response('unexpected',1));vi.stubGlobal('fetch',provider);
 const f=await fixture();const events:any[]=[];
 try{
  const prompt='的'.repeat(200001);
  await f.harness.run('fixture',{sessionId:'oversized-cjk',systemPrompt:'test',tools:[],prompt},e=>events.push(e),new AbortController().signal);
  expect(provider.mock.calls.length).toBe(0);
  expect(events.some(e=>e.type==='error'&&e.message.includes('200000')&&e.message.includes('拆分'))).toBe(true);
  const history=await f.harness.history('oversized-cjk');
  expect(JSON.stringify(history)).toContain(prompt);
 }finally{await f.close()}
},20000);


it('reserves the adapter default output when only the 200K context is configured',async()=>{
 const requests:any[]=[];
 const provider=vi.fn(async(_url,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);return response('Preserve the task.',1)});vi.stubGlobal('fetch',provider);
 const f=await fixture(null);const events:any[]=[];
 try{
  await f.harness.run('fixture',{sessionId:'default-output',systemPrompt:'test',tools:[],prompt:'的'.repeat(180000)},e=>events.push(e),new AbortController().signal);
  expect(requests.some(r=>JSON.stringify(r.messages.at(-1)).includes('compaction engine'))).toBe(true);
  expect(requests.every(r=>(JSON.stringify(r.messages).match(/的/g)?.length??0)+(r.max_tokens??r.max_completion_tokens??0)<200000)).toBe(true);
  expect(requests.at(-1).max_completion_tokens??requests.at(-1).max_tokens).toBe(32768);
  expect(events.filter(e=>e.type==='error')).toEqual([]);
 }finally{await f.close()}
},20000);

it('enforces the same 200K budget through native session prompts',async()=>{
 const provider=vi.fn(async()=>response('unexpected',1));vi.stubGlobal('fetch',provider);
 const f=await fixture();
 try{
  const native=await f.harness.nativeApi();
  const {sessionId}=await native.gateway.invoke({namespace:'session',method:'create',args:{request:{}}}) as {sessionId:string};
  await native.gateway.invoke({namespace:'session',method:'prompt',args:{request:{sessionId,requestId:'native-overflow',mode:'queue',content:[{type:'text',text:'的'.repeat(200001)}]}}});
  const agent=await native.resolveAgent(sessionId);
  await agent.whenIdle();
  expect(provider.mock.calls.length).toBe(0);
  expect(JSON.stringify(await f.harness.history(sessionId))).toContain('的'.repeat(200001));
 }finally{await f.close()}
},20000);

it('includes application system text and tool definitions in the 200K budget',async()=>{
 const provider=vi.fn(async()=>response('unexpected',1));vi.stubGlobal('fetch',provider);
 const f=await fixture();const events:any[]=[];
 try{
  await f.harness.run('fixture',{sessionId:'system-tools-budget',systemPrompt:'的'.repeat(110000),tools:[{name:'large_schema',description:'的'.repeat(100000),parameters:{type:'object',properties:{}}}],prompt:'continue'},e=>events.push(e),new AbortController().signal);
  expect(provider.mock.calls.length).toBe(0);
  expect(events.some(e=>e.type==='error'&&e.message.includes('200000'))).toBe(true);
 }finally{await f.close()}
},20000);
