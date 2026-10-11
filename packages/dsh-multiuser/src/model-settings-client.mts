/** Personal model configuration stays behind the authenticated Server API. */
export async function requestModelSettings(payload?: unknown) {
  const response = await fetch("/api/agent/settings", {
    method: payload === undefined ? "GET" : "PUT", credentials: "include",
    ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.error || "模型设置请求失败");
  return body.data;
}
