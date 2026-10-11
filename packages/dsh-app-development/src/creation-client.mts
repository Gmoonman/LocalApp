/** Browser creation API shared by the platform modal and native client plugin. */
export interface Creation {
  projectId: string;
  sessionId: string;
  providerId: string;
  proposal?: { name: string; description: string };
  url?: string;
  createdAt?: string;
}
export async function request(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET", credentials: "include",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  if (!response.ok || !json.success) throw new Error(json.error || "请求失败");
  return json.data;
}
export async function nativeRequest(draft: Creation, method: string, args: unknown, signal: AbortSignal) {
  const response = await fetch(`/api/development/projects/${encodeURIComponent(draft.projectId)}/native/${encodeURIComponent(draft.providerId)}/api/session/${method}`, {
    method: "POST", credentials: "include", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method: `session/${method}`, payload: { args } }),
  });
  const json = await response.json();
  if (!response.ok || !json.result?.ok) throw new Error(json.result?.error?.message || json.error || "对话失败");
  return json.result.value;
}
