/** The Server determines the authenticated user's access to the requested scope. */
export interface CapabilitySettingsSelection {
  enabledCapabilities: string[];
  enabledSkills: string[];
  disabledTools: string[];
}
export async function requestCapabilitySettings(appId: string, selection?: CapabilitySettingsSelection) {
  const response = await fetch(selection === undefined
    ? `/api/agent/app-settings?${new URLSearchParams({ appId })}`
    : "/api/agent/app-settings", {
    method: selection === undefined ? "GET" : "PUT", credentials: "include",
    ...(selection === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, ...selection }),
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.error || "Agent 设置请求失败");
  return body.data;
}
