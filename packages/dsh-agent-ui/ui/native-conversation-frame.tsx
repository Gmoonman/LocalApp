"use client";
import {useEffect,useRef} from "react";
import {createNativeComposerTransport, type NativeComposerAction} from "./native-composer-transport";
export interface NativeComposerPort { request(action: NativeComposerAction, prompt?: string, files?: readonly File[]): Promise<void> }
export interface NativeSelection { sessionId:string; title:string; running:boolean }
export interface NativeCatalogEntry { id:string;title:string;updatedAt:number;pinned?:boolean }
export interface NativeAttachment {id:string;name:string;size:number}
export interface NavigationProps {
  onAttachments?: (files: NativeAttachment[]) => void;
  onComposerReady?: (port: NativeComposerPort | null) => void;
  sessionId?:string;
  newSession?:number;
  onSelection?:(selection:NativeSelection|null)=>void;
  onCatalog?:(sessions:NativeCatalogEntry[])=>void;
}
export function NativeConversationFrame(props: NavigationProps & {
  src: string; title: string; bind?: (frame: HTMLIFrameElement) => () => void;
}) {
  const frame=useRef<HTMLIFrameElement>(null);
  const navigation=useRef(props);
  navigation.current=props;
  const ready=useRef(false);
  const selected=useRef<string|null>(null);
  const awaitingSelection=useRef<{resolve:(id:string)=>void;reject:(error:Error)=>void}|null>(null);
  const {src, bind}=props;
  useEffect(()=>{
    const target=frame.current?.contentWindow;
    if(!target)return;
    const transport=createNativeComposerTransport(target,window.location.origin);
    let disposed=false;
    navigation.current.onComposerReady?.({request:async(action,prompt,files)=>{
      if(disposed)throw new Error("原生对话已关闭");
      if(!ready.current)throw new Error("原生会话尚未就绪");
      let id=selected.current;
      if(!id && ["draft","submit","attach"].includes(action)) {
        if(awaitingSelection.current)throw new Error("正在打开原生会话");
        id=await new Promise<string>((resolve,reject)=>{
          const finish=(error:Error|null,id?:string)=>{
            clearTimeout(timer);awaitingSelection.current=null;
            if(error)reject(error);else resolve(id!);
          };
          const timer=setTimeout(()=>finish(new Error("原生会话创建超时")),15000);
          awaitingSelection.current={resolve:id=>finish(null,id),reject:error=>finish(error)};
          target.postMessage({type:"localapp:native-new-session"},window.location.origin);
        });
      }
      if(!id)throw new Error("原生会话尚未就绪");
      if(disposed||selected.current!==id)throw new Error("会话已切换");
      return transport.request(id,action,prompt,files);
    }});
    return()=>{disposed=true;awaitingSelection.current?.reject(new Error("原生对话已关闭"));transport.dispose();navigation.current.onComposerReady?.(null);};
  },[src]);
  useEffect(()=>{
    if(!bind||!frame.current)return;
    return bind(frame.current);
  },[bind,src]);
  useEffect(()=>{
    ready.current=false;selected.current=null;
    const receive=(event:MessageEvent)=>{
      if(event.source!==frame.current?.contentWindow||event.origin!==window.location.origin)return;
      if(event.data?.type==="localapp:native-attachments"){
        const data=event.data;
        if(data.sessionId!==selected.current)return;
        if(Array.isArray(data.attachments)&&data.attachments.every((file:any)=>file&&typeof file.id==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(file.id)&&typeof file.name==="string"&&Number.isFinite(file.size)&&file.size>=0))navigation.current.onAttachments?.(data.attachments);
        return;
      }
      if(event.data?.type==="localapp:native-catalog"){
        const rows=event.data.sessions;
        if(Array.isArray(rows)&&rows.length<=10000&&rows.every(row=>row&&typeof row.id==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(row.id)&&typeof row.title==="string"&&Number.isFinite(row.updatedAt)&&(row.pinned===undefined||typeof row.pinned==="boolean")))navigation.current.onCatalog?.(rows);
        return;
      }
      if(event.data?.type!=="localapp:native-selection")return;
      const state=event.data.state;
      if(state!==null&&(!state||typeof state.sessionId!=="string"||!/^[a-zA-Z0-9_-]{1,128}$/.test(state.sessionId)||typeof state.title!=="string"||typeof state.running!=="boolean"))return;
      const first=!ready.current;ready.current=true;selected.current=state?.sessionId??null;
      // Restore the enclosing history selection once native services are ready.
      if(first&&navigation.current.sessionId&&navigation.current.sessionId!==selected.current){
        frame.current?.contentWindow?.postMessage({type:"localapp:native-select",sessionId:navigation.current.sessionId},window.location.origin);
        return;
      }
      if(state)awaitingSelection.current?.resolve(state.sessionId);
      navigation.current.onSelection?.(state);
    };
    window.addEventListener("message",receive);
    return()=>window.removeEventListener("message",receive);
  },[src]);
  useEffect(()=>{
    if(ready.current&&props.sessionId&&props.sessionId!==selected.current){
      awaitingSelection.current?.reject(new Error("会话已切换"));
      frame.current?.contentWindow?.postMessage({type:"localapp:native-select",sessionId:props.sessionId},window.location.origin);
    }
  },[props.sessionId]);
  useEffect(()=>{
    if(ready.current&&props.newSession)frame.current?.contentWindow?.postMessage({type:"localapp:native-new-session"},window.location.origin);
  },[props.newSession]);
  return <iframe key={src} ref={frame} onLoad={()=>frame.current?.contentWindow?.postMessage({type:"localapp:native-selection-request"},window.location.origin)} title={props.title} src={src} className="native-conversation-frame" style={{width:"100%",height:"100%",minHeight:0,border:0}} />;
}
