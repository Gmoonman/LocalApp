"use client";
import { useEffect, useState } from "react";
import { Button } from "@localapp/dsh-multiuser/ui/shadcn/button";
import { Input } from "@localapp/dsh-multiuser/ui/shadcn/input";
import { Label } from "@localapp/dsh-multiuser/ui/shadcn/label";
export function SystemDevelopmentEnvironment() {
  const [report, setReport] = useState<any>(null),
    [directory, setDirectory] = useState(""),
    [origin, setOrigin] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/system/development-environment", {
        credentials: "include",
      });
      const json = await response.json();
      if (!response.ok) throw Error(json.error);
      setReport(json.data);
      setDirectory(
        json.data.settings.dependenciesDirectory ??
          json.data.dependenciesDirectory ??
          "",
      );
      setOrigin(json.data.settings.previewOrigin ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/system/development-environment", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(directory ? { dependenciesDirectory: directory } : {}),
          ...(origin ? { previewOrigin: origin } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw Error(json.error);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">应用开发环境</h2>
      <p className="text-sm text-muted-foreground">
        依赖由管理员准备，项目构建读取共用依赖，缓存写入各自工作目录。首版构建关闭网络，不自动下载新依赖。
      </p>
      <div className="space-y-2">
        <Label htmlFor="development-dependencies">模板依赖目录</Label>
        <Input
          id="development-dependencies"
          value={directory}
          placeholder="绝对路径 /…/node_modules"
          onChange={(e) => setDirectory(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="development-preview-origin">独立预览地址</Label>
        <Input
          id="development-preview-origin"
          value={origin}
          placeholder="https://{previewId}.preview.example.com"
          onChange={(e) => setOrigin(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          远程部署需通配 DNS 与 TLS，并指向同一
          Server。本机留空使用每次预览独立的 .localhost 地址。
        </p>
      </div>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void save()}>
          保存
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          检查环境
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {report && (
        <>
          <p>
            Node {report.nodeVersion} ·{" "}
            {report.ready ? "基础环境已就绪" : "环境未就绪"}
          </p>
          {report.checks.map((c: any) => (
            <div key={c.id} className="rounded border p-3">
              {c.ready ? "✓" : "✗"} {c.detail}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            应用测试若需要启动网络服务，当前离线执行环境可能无法完成；失败的构建不能发布。
          </p>
        </>
      )}
    </section>
  );
}
