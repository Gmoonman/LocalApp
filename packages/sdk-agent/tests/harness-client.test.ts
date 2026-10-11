import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessAgent } from "../src/harness-client.js";

afterEach(() => vi.unstubAllGlobals());
function stream(events: unknown[]) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
}
describe("Harness browser client", () => {
  it("streams text and preserves structured tool results", async () => {
    let release: () => void = () => {};
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("tool-result")) {
        expect(JSON.parse(init.body).result).toEqual({ id: 1 });
        release();
        return new Response('{}');
      }
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(encoder.encode('data: {"type":"assistant_start"}\n\ndata: {"type":"text_delta","text":"你好"}\n\ndata: {"type":"tool_call","token":"token","name":"create","args":{}}\n\n'));
        release = () => { c.enqueue(encoder.encode('data: {"type":"done"}\n\n')); c.close(); };
      } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = new HarnessAgent({ initialState: { systemPrompt: "test" } });
    agent.state.tools = [{ name: "create", description: "create", parameters: {}, execute: async () => ({ content: [], details: { id: 1 } }) }];
    await agent.prompt("hello");
    expect(agent.state.messages.at(-1)?.content).toEqual([{ type: "text", text: "你好" }]);
    expect(agent.state.errorMessage).toBeUndefined();
    expect(agent.state.isStreaming).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("reports authentication, upstream errors and truncated streams", async () => {
    for (const response of [new Response('', { status: 401 }), stream([{ type: "error", message: "model failed" }]), stream([{ type: "assistant_start" }])]) {
      vi.stubGlobal("fetch", vi.fn(async () => response));
      const agent = new HarnessAgent({ initialState: { systemPrompt: "" } });
      await agent.prompt("hello");
      expect(agent.state.errorMessage).toBeTruthy();
      expect(agent.state.isStreaming).toBe(false);
    }
  });
  it("prevents overlapping prompts", async () => {
    let release: (res: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const agent = new HarnessAgent({ initialState: { systemPrompt: "" } });
    const first = agent.prompt("first");
    await agent.prompt("second");
    expect(agent.state.messages).toHaveLength(1);
    release(stream([{ type: "done" }]));
    await first;
  });
});

it("executes background page tools after the foreground stream is complete", async () => {
  let posted: any;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    if (url.includes("/events?")) return stream([{ type: "status", running: true }, { type: "tool_call", token: "later", name: "page", args: {} }, { type: "status", running: false }]);
    if (url.endsWith("tool-result")) { posted = JSON.parse(init.body); return new Response('{"success":true}'); }
    return stream([{ type: "done" }]);
  }));
  const agent = new HarnessAgent({ initialState: { systemPrompt: "" }, appId: "owner/app" });
  agent.state.tools = [{ name: "page", description: "page", parameters: {}, execute: async () => ({ content: [], details: { done: true } }) }];
  await agent.prompt("first");
  agent.startBackgroundEvents();
  await vi.waitFor(() => expect(posted).toEqual({ token: "later", result: { done: true } }));
  expect(agent.state.isStreaming).toBe(false);
  agent.dispose();
});

it("connects native sessions with application context without sending tool callbacks",async()=>{
 const calls:Array<{url:string;body:any}>=[];
 vi.stubGlobal("fetch",vi.fn(async(url:string,init:any)=>{
  if(url.includes("/events?")) return new Response(new ReadableStream({start(){},cancel(){}}));
  const body=JSON.parse(init.body);calls.push({url,body});
  return new Response(JSON.stringify(url.endsWith("session/create")?{result:{ok:true,value:{sessionId:body.payload.args.request.sessionId}}}:{success:true}));
 }));
 const agent=new HarnessAgent({appId:"owner/application",initialState:{systemPrompt:"Application instruction"}});agent.providerId="model-one";
 agent.state.tools=[{name:"app-edit",description:"Edit application data",parameters:{type:"object"},execute:async()=>({content:[]})}];
 const connected=await agent.connectNativeSession("native-session");
 expect(connected.url).toContain("/api/agent/native/");expect(agent.sessionId).toBe("native-session");
 expect(calls[1].body).toEqual({sessionId:"native-session",appId:"owner/application",providerId:"model-one",systemPrompt:"Application instruction",tools:[{name:"app-edit",description:"Edit application data",parameters:{type:"object"}}]});
 const scope=connected.url.split("/native/")[1].split("/")[0];expect(JSON.parse(atob(scope.replace(/-/g,"+").replace(/_/g,"/")))).toEqual({appId:"owner/application",providerId:"model-one"});
 agent.dispose();
});
it("leaves the SDK session unchanged when native context binding fails",async()=>{
 const agent=new HarnessAgent({appId:"owner/application",initialState:{systemPrompt:"test"}});agent.providerId="model-one";const original=agent.sessionId;
 vi.stubGlobal("fetch",vi.fn(async(url:string,init:any)=>new Response(JSON.stringify(url.endsWith("session/create")?{result:{ok:true,value:{sessionId:JSON.parse(init.body).payload.args.request.sessionId}}}:{success:false,error:"binding refused"}),{status:url.endsWith("session/create")?200:400})));
 await expect(agent.connectNativeSession("another-session")).rejects.toThrow("binding refused");expect(agent.sessionId).toBe(original);agent.dispose();
});
