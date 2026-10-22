"use client";
import { useEffect, useRef, useState } from "react";
import type { DockIdentityProps } from "./app-development-dock";
import type { DevelopmentShellProps } from "./development-types";
export interface DevelopmentPageProps {
  application?: {owner: string; name: string};
  dock?: DockIdentityProps;
  initialProjectId?: string;
  workspaceOnly?: boolean;
}
export interface DevelopmentPageComponents {
  AppDevelopmentDock: React.JSXElementConstructor<any>;
  DshDevelopmentShell: React.JSXElementConstructor<DevelopmentShellProps>;
}
type Project = { id: string; name: string };
type Version = { id: string; message: string };
type FileValue = { path: string; content: string; hash: string };
async function request(url: string, method = "GET", body?: unknown) {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error ?? "请求失败");
  return json.data;
}
export function createDevelopmentPage(components: DevelopmentPageComponents) {
const {AppDevelopmentDock, DshDevelopmentShell} = components;
return function DevelopmentPage({
  application,
  dock,
  confirmAction,
  initialProjectId,
  workspaceOnly = false,
}: DevelopmentPageProps & {confirmAction: (message: string) => Promise<boolean>}) {
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState<Project | null>(null),
    [files, setFiles] = useState<string[]>([]),
    [file, setFile] = useState<FileValue | null>(null),
    [text, setText] = useState(""),
    [prompt, setPrompt] = useState(""),
    [messages, setMessages] = useState<any[]>([]),
    [sessions, setSessions] = useState<
      Array<{ id: string; createdAt: string; title?: string }>
    >([]),
    [live, setLive] = useState(""),
    [running, setRunning] = useState(false),
    [error, setError] = useState(""),
    [versions, setVersions] = useState<Version[]>([]),
    [version, setVersion] = useState(""),
    [changes, setChanges] = useState<any[]>([]),
    [interaction, setInteraction] = useState<any>(null),
    [answer, setAnswer] = useState(""),
    [providers, setProviders] = useState<any[]>([]),
    [provider, setProvider] = useState(""),
    [build, setBuild] = useState<any>(null),
    [log, setLog] = useState(""),
    [pending, setPending] = useState(false),
    [settingsReady, setSettingsReady] = useState(false);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; name: string; size: number; path?: string }>
  >([]);
  const diffBaseline = useRef("");
  const nativeGeneration=useRef(0);
  const nativeTurn = useRef<{sessionId:string;version:string;generation:number;token:number}|null>(null);
  const nativeComposer=useRef<{request(action:"submit",prompt?:string):Promise<void>}|null>(null);
  const [handoff, setHandoff] = useState<{
    sessionId: string;
    providerId: string;
  } | null>(null);
  const handoffStarted = useRef(false);
  const previewedBuild = useRef("");
  const autoPreviewBuild = useRef("");
  const handledFailure = useRef("");
  const repairAttempts = useRef(0);
  const session = useRef(""),
    abort = useRef<AbortController | null>(null),
    selection = useRef(0);
  const projectGeneration=useRef(0);
  const base = project ? `/api/development/projects/${project.id}` : "";
  const act = async (fn: () => Promise<void>) => {
    setError("");
    setPending(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    void act(async () => {
      setProjects(await request("/api/development/projects"));
      const settings = await request("/api/agent/settings");
      setProviders(settings.providers);
      setProvider(
        settings.defaultProviderId || settings.providers?.[0]?.id || "",
      );
      setSettingsReady(true);
    });
    return () => abort.current?.abort();
  }, []);
  useEffect(() => {
    if (!settingsReady) return;
    if (!application) {
      const requestedId = initialProjectId ?? new URLSearchParams(window.location.search).get(
        "projectId",
      );
      const requested = projects.find((p) => p.id === requestedId);
      if (requested) select(requested);
      return;
    }
    void act(async () => {
      const p = await request(
        `/api/development/apps/${encodeURIComponent(application.owner)}/${encodeURIComponent(application.name)}/source`,
      );
      if (p) select(p);
    });
  }, [application?.owner, application?.name, settingsReady, initialProjectId]);
  const View = application ? AppDevelopmentDock : DshDevelopmentShell;
  async function refresh(id: string) {
    const b = `/api/development/projects/${id}`;
    setFiles(await request(b + "/files"));
    const v = await request(b + "/versions");
    setVersions(v);
    setVersion(v[0]?.id ?? "");
    if (!diffBaseline.current) diffBaseline.current = v[0]?.id ?? "";
  }
  function select(p: Project) {
    selection.current++;projectGeneration.current++;
    nativeTurn.current=null;nativeGeneration.current++;
    abort.current?.abort();
    setProject(p);
    setAttachments([]);
    diffBaseline.current = "";
    setFile(null);
    setText("");
    setMessages([]);
    setSessions([]);
    setLive("");
    setBuild(null);
    setLog("");
    setChanges([]);
    session.current = "";
    void act(async () => {
      await refresh(p.id);
      const builds = await request(`/api/development/projects/${p.id}/builds`);
      setBuild(builds[0] ?? null);
      if (builds[0]?.sourceVersion)
        diffBaseline.current = builds[0].sourceVersion;
      setLog(builds[0]?.log ?? "");
      if (provider && !workspaceOnly) {
        const sessions = await request(
          `/api/development/projects/${p.id}/agent/sessions`,
        );
        setSessions(sessions);
        if (sessions.length) session.current = sessions[sessions.length - 1].id;
        {
          if (
            application &&
            new URLSearchParams(window.location.search).get("creation") === p.id
          ) {
            const creation = await request(
              `/api/development/creations/${p.id}`,
            );
            session.current = creation.sessionId;
            setProvider(creation.providerId);
            if (!creation.continued)
              setHandoff({
                sessionId: creation.sessionId,
                providerId: creation.providerId,
              });
          }
          if (session.current)
            setMessages(
              await request(
                `/api/development/projects/${p.id}/agent/history?sessionId=${encodeURIComponent(session.current)}`,
              ),
            );
        }
      }
    });
  }
  async function open(path: string) {
    const seq = ++selection.current;
    const f = await request(base + `/file?path=${encodeURIComponent(path)}`);
    if (seq !== selection.current) return;
    setFile(f);
    setText(f.content);
  }
  async function save() {
    if (!file) return;
    const updated = await request(base + "/file", "PUT", {
      path: file.path,
      hash: file.hash,
      content: text,
    });
    setFile(updated);
    await refresh(project!.id);
    const builds = await request(base + "/builds");
    const active = builds.find((b: any) => ["queued", "running"].includes(b.status));
    setBuild(active ?? null);
    setLog(active?.log ?? "");
  }
  useEffect(() => {
    if (
      !handoff ||
      !project ||
      handoffStarted.current ||
      provider !== handoff.providerId ||
      running ||
      pending
    )
      return;
    handoffStarted.current = true;
    void act(async()=>{
      const result=await request(`/api/development/creations/${project.id}/continue`,"POST",{});
      if(!result.accepted)throw new Error("创建任务尚未接收，请刷新重试");
      setHandoff(null);
    });
  }, [handoff, project, provider, pending, running]);
  async function run(options?: {
    prompt?: string;
    repairPreview?: boolean;
  }) {
    const submitted = options?.prompt ?? prompt;
    if (!project || !submitted.trim() || running) return;
    if (!options?.repairPreview) repairAttempts.current = 0;
    if (file && file.content !== text) await save();
    if(application && nativeComposer.current){
      setError("");
      await nativeComposer.current.request("submit",submitted);
      return;
    }
    setBuild(null);
    setRunning(true);
    setError("");
    setLive("");
    setInteraction(null);
    const controller = new AbortController();
    abort.current = controller;
    const submittedAttachments = attachments;
    let completed = false,
      streamError = false;
    setPrompt("");
    try {
      const res = await fetch(base + "/agent/run", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: submitted,
          attachmentIds: submittedAttachments.map((file) => file.id),
          providerId: provider,
          ...(session.current ? { sessionId: session.current } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.error);
      }
      setAttachments([]);
      const reader = res.body!.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const part = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const e = JSON.parse(line.slice(6));
            if (e.type === "session") session.current = e.sessionId;
            if (e.type === "session_title" && e.title) {
              setSessions((rows) =>
                rows.some((row) => row.id === e.sessionId)
                  ? rows.map((row) =>
                      row.id === e.sessionId ? { ...row, title: e.title } : row,
                    )
                  : [
                      ...rows,
                      {
                        id: e.sessionId,
                        createdAt: new Date().toISOString(),
                        title: e.title,
                      },
                    ],
              );
            }
            if (e.type === "messages") {
              setMessages(e.messages);
              setLive("");
            }
            if (e.type === "text_delta")
              setLive((x) => x + (e.delta ?? e.text ?? ""));
            if (e.type === "interaction") setInteraction(e);
            if (e.type === "error") {
              setError(e.message);
              streamError = true;
            }
          }
        }
      }
      completed = !streamError && !controller.signal.aborted;
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      setRunning(false);
      setInteraction(null);
      await refresh(project.id);
      setSessions(await request(base + "/agent/sessions"));
      if (file) await open(file.path);
      if (completed && application) {
        try {
          const previewBuild = await request(base + "/builds", "POST", {
            purpose: "preview",
          });
          autoPreviewBuild.current = previewBuild.id;
          setBuild(previewBuild);
          setLog(previewBuild.log ?? "");
        } catch (error) {
          setError((error as Error).message);
        }
      }
    }
  }
  useEffect(() => {
    if (!project || !sessions.length) return;
    // Auxiliary title generation can finish after the main conversation stream.
    let active = true;
    let attempts = 0;
    const timer = setInterval(async () => {
      try {
        const rows = await request(base + "/agent/sessions");
        if (active) setSessions(rows);
      } catch {
        /* Keep the last known titles when the Server is unavailable. */
      }
      if (++attempts >= 10) clearInterval(timer);
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project?.id, running]);
  useEffect(() => {
    if (!project) return;
    let active = true;
    let polling = false;
    let lastResult = "";
    const observe = async () => {
      if (polling) return;
      polling = true;
      try {
        const rows = await request(base + "/builds");
        if (!active || !rows.length) return;
        const latest = rows[0];
        const result = JSON.stringify(latest);
        if (result === lastResult) return;
        lastResult = result;
        setBuild((current: any) => {
          if (current && current.id !== latest.id && current.createdAt > latest.createdAt) return current;
          return latest;
        });
        setLog(latest.log ?? "");
      } catch {
        // Preserve the last visible result during a transient connection loss.
      } finally { polling = false; }
    };
    void observe();
    const timer = setInterval(() => void observe(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [base, project?.id]);
  async function stop() {
    await request(base + "/agent/cancel", "POST", {
      sessionId: session.current,
    });
    abort.current?.abort();
  }
  async function respond(result: unknown) {
    await request(base + "/agent/respond", "POST", {
      token: interaction.token,
      result,
    });
    setInteraction(null);
    setAnswer("");
  }
  async function buildProject(purpose: "release" | "preview" = "release") {
    if (file && text !== file.content) await save();
    const builds = await request(base + "/builds");
    const active = builds.find((b: any) => ["queued", "running"].includes(b.status));
    if (active) {
      setBuild(active);
      setLog(active.log ?? "");
      return;
    }
    const b = await request(base + "/builds", "POST", { purpose });
    setBuild(b);
    setLog(b.log ?? "");
  }
  useEffect(() => {
    if (!build || !["queued", "running"].includes(build.status)) return;
    const timer = setInterval(() => {
      void request(base + `/builds/${build.id}`)
        .then((b) => {
          setBuild(b);
          setLog(b.log ?? "");
        })
        .catch((e) => setError(e.message));
    }, 1000);
    return () => clearInterval(timer);
  }, [base, build]);
  useEffect(() => {
    if (!build || build.status !== "failed" || running || pending || handledFailure.current === build.id) return;
    handledFailure.current = build.id;
    const preview = build.purpose === "preview";
    if (preview && application && autoPreviewBuild.current === build.id && repairAttempts.current < 2) {
      repairAttempts.current++;
      void act(() => run({repairPreview: true, prompt: `平台预览编译失败（自动修复 ${repairAttempts.current}/2）。请根据以下真实日志修复源码；不要移除类型检查、删减测试或修改构建脚本。完成后平台会重新编译。\n${build.log ?? "未返回日志"}`}));
    } else {
      setError(`${preview ? "预览编译" : "完整构建"}失败，应用尚未更新。请查看构建日志。`);
    }
  }, [build?.id, build?.status, running, pending]);
  useEffect(() => {
    if (dock?.identity === "user") {
      previewedBuild.current = "";
      return;
    }
    if (
      !application ||
      !dock?.onPreview ||
      build?.status !== "succeeded" ||
      previewedBuild.current === build.id
    )
      return;
    let active = true;
    previewedBuild.current = build.id;
    void (async () => {
      // A build that is already the live release has nothing left to preview, and
      // auto-opening it covers the published application with a development
      // preview: the publish flow reloads the Shell, which remounts this dock and
      // used to reopen the just-published build over the production app.
      try {
        const delivery = await request(base + "/delivery");
        const releases = Array.isArray(delivery?.releases) ? delivery.releases : [];
        if (releases.some((release: any) => release?.buildId === build.id)) return;
      } catch {
        // Delivery is advisory here: when it cannot be read, keep the old behavior.
      }
      try {
        const preview = await request(base + "/previews", "POST", { buildId: build.id });
        if (active) dock?.onPreview?.(preview.url);
      } catch (error) {
        if (active) { previewedBuild.current = ""; setError((error as Error).message); }
      }
    })();
    return () => { active = false; previewedBuild.current = ""; };
  }, [build?.id, build?.status, dock?.identity, application?.owner, application?.name, base]);
  return (
    <View
      {...(application
        ? {
            application,
            ...dock,
            importSource: async (files: Record<string, string>) => {
              const p = await request(
                `/api/development/apps/${encodeURIComponent(application.owner)}/${encodeURIComponent(application.name)}/source`,
                "POST",
                { files },
              );
              setProjects((x) => [p, ...x]);
              select(p);
            },
          }
        : {})}
      attachments={attachments}
      sessions={sessions}
      selectedSession={session.current}
      projects={projects}
      project={project}
      files={files}
      file={file}
      text={text}
      prompt={prompt}
      messages={messages}
      live={live}
      running={running}
      pending={pending}
      error={error}
      versions={versions}
      version={version}
      changes={changes}
      providers={providers}
      provider={provider}
      build={build}
      log={log}
      interaction={interaction}
      answer={answer}
      actions={{
        upload: (files) =>
          void act(async () => {
            if (!files?.length || !project || running) return;
            if (attachments.length + files.length > 10)
              throw new Error("每次最多发送 10 个附件");
            for (const file of Array.from(files)) {
              const body = new FormData();
              body.append("file", file);
              const response = await fetch(base + "/attachments", {
                method: "POST",
                credentials: "include",
                body,
              });
              const result = await response.json();
              if (!response.ok || !result.success)
                throw new Error(result.error ?? "上传失败");
              setAttachments((current) => [...current, result.data]);
            }
          }),
        nativeComposerReady: port=>{nativeComposer.current=port;},
        nativeActivity: (sessionId, active) => {
          if(!project)return;
          if(active){
            nativeTurn.current={sessionId,version:versions[0]?.id??"",generation:projectGeneration.current,token:++nativeGeneration.current};
            setBuild(null);setLog("");setError("");
            return;
          }
          const turn=nativeTurn.current;
          if(!turn||turn.sessionId!==sessionId)return;
          nativeTurn.current=null;
          void act(async()=>{
            const [latestFiles,latestVersions]=await Promise.all([request(base+"/files"),request(base+"/versions")]);
            if(projectGeneration.current!==turn.generation||nativeGeneration.current!==turn.token)return;
            setFiles(latestFiles);setVersions(latestVersions);setVersion(latestVersions[0]?.id??"");
            if(file&&latestFiles.includes(file.path)){
              const fileSequence=selection.current;
              const updated=await request(base+`/file?path=${encodeURIComponent(file.path)}`);
              if(projectGeneration.current===turn.generation&&nativeGeneration.current===turn.token&&selection.current===fileSequence){setFile(updated);setText(updated.content);}
            }
            if(projectGeneration.current!==turn.generation||nativeGeneration.current!==turn.token)return;
            if(application&&latestVersions[0]?.id!==turn.version){
              const builds=await request(base+"/builds");
              if(projectGeneration.current!==turn.generation||nativeGeneration.current!==turn.token)return;
              const previewBuild=builds.find((build:any)=>build.status==="queued"||build.status==="running")??await request(base+"/builds","POST",{purpose:"preview"});
              if(projectGeneration.current!==turn.generation||nativeGeneration.current!==turn.token)return;
              autoPreviewBuild.current=previewBuild.id;setBuild(previewBuild);setLog(previewBuild.log??"");
            }
          });
        },
        removeAttachment: (id) =>
          setAttachments((current) => current.filter((file) => file.id !== id)),
        select,
        selectSession: (id) =>
          void act(async () => {
            if (running) return;
            const history = await request(
              base + `/agent/history?sessionId=${encodeURIComponent(id)}`,
            );
            session.current = id;
            setMessages(history);
            setLive("");
          }),
        create: (name) =>
          void act(async () => {
            const p = await request("/api/development/projects", "POST", {
              name,
            });
            setProjects((x) => [p, ...x]);
            select(p);
          }),
        open: (path) => void act(() => open(path)),
        setText,
        save: () => void act(save),
        setPrompt,
        run: () => void act(run),
        stop: () => void act(stop),
        setProvider,
        newSession: () => {
          if (running) return;
          session.current = "";
          setAttachments([]);
          setMessages([]);
          setLive("");
          setPrompt("");
        },
        setVersion,
        diff: () =>
          void act(async () => {
            setChanges(
              await request(
                base +
                  `/diff?version=${application ? diffBaseline.current : version}`,
              ),
            );
          }),
        restore: () =>
          void act(async () => {
            if (
              !await confirmAction(
                "恢复这个源码版本？当前改动会自动保存。正式应用不会改变。",
              )
            )
              return;
            await request(base + "/restore", "POST", { version });
            await refresh(project!.id);
            setFile(null);
            setText("");
            setChanges([]);setBuild(null);setLog("");previewedBuild.current="";autoPreviewBuild.current="";
            dock?.onPreview?.(null);
          }),
        build: () => void act(() => buildProject()),
        preview: () =>
          void act(async () => {
            const preview = await request(base + "/previews", "POST", {
              buildId: build.id,
            });
            if (application && dock?.onPreview) dock.onPreview(preview.url);
            else window.open(preview.url, "_blank", "noopener");
          }),
        publish: () =>
          void act(async () => {
            const expected = await request(base + "/release-target");
            if (
              !await confirmAction(
                `发布 ${project!.name} 的这次构建？当前源码后续的修改不会包含在内。`,
              )
            )
              return;
            const result = await request(base + "/releases", "POST", {
              buildId: build.id,
              expectedVersion: expected.version,
              idempotencyKey: build.id,
            });
            setLog((x) => x + "\n已发布：" + result.url);
            // Close the development preview before returning to the published app,
            // otherwise the remounting dock reopens it over the production build.
            if (application) dock?.onPreview?.(null);
            if (application) window.location.reload();
          }),
        cancelBuild: () =>
          void act(async () => {
            await request(base + `/builds/${build.id}/cancel`, "POST", {});
          }),
        newFile: (path) =>
          void act(async () => {
            await request(base + "/file", "PUT", {
              path,
              content: "",
              hash: null,
            });
            await refresh(project!.id);
            await open(path);
          }),
        respond: (result) => void act(() => respond(result)),
        setAnswer,
      }}
    />
  );
}

}
