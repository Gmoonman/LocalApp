export type AccessLevel = "public" | "authenticated" | "owner" | "acl";
export interface PageAccess { level: AccessLevel; acl?: string[]; }
export interface RouteAccess { read?: AccessLevel; create?: AccessLevel; update?: AccessLevel; delete?: AccessLevel; acl?: string[]; }
export interface ManifestDbAccess { read?: AccessLevel; create?: AccessLevel; update?: AccessLevel; delete?: AccessLevel; }

type GroupMembershipResolver = (userId: string, groupName: string) => boolean;

let groupMembershipResolver: GroupMembershipResolver | null = null;

export function setGroupMembershipResolver(resolver: GroupMembershipResolver | null): void {
  groupMembershipResolver = resolver;
}

export function checkAccess(level: AccessLevel, visitorId: string | null | undefined, ownerId: string, acl?: string[]): boolean {
  if (visitorId === ownerId) return true;

  switch (level) {
    case "public":
      return true;
    case "authenticated":
      return !!visitorId;
    case "owner":
      return false;
    case "acl":
      return !!visitorId && resolveAcl(visitorId, acl);
    default:
      return true;
  }
}

function resolveAcl(visitorId: string, acl: string[] | undefined): boolean {
  if (!acl) return false;
  for (const entry of acl) {
    if (entry.startsWith("group:")) {
      const groupName = entry.slice(6);
      if (groupMembershipResolver?.(visitorId, groupName)) return true;
    } else {
      if (entry === visitorId) return true;
    }
  }
  return false;
}

export function checkPageAccess(pageAccess: PageAccess | undefined, visitorId: string | null | undefined, ownerId: string): boolean {
  const policy = pageAccess ?? { level: "public" as AccessLevel };
  return checkAccess(policy.level, visitorId, ownerId, policy.acl);
}

type ActionKey = "read" | "create" | "update" | "delete";

const METHOD_TO_ACTION: Record<string, ActionKey> = {
  GET: "read",
  POST: "create",
  PUT: "update",
  DELETE: "delete",
};

export function checkRouteAccess(
  routeAccess: RouteAccess | undefined,
  method: string,
  visitorId: string | null | undefined,
  ownerId: string,
): boolean {
  if (!routeAccess) return true;

  const action = METHOD_TO_ACTION[method];
  if (!action) return true;

  const level = routeAccess[action] ?? "public";
  return checkAccess(level as AccessLevel, visitorId, ownerId, routeAccess.acl);
}

export function checkRouteAccessWithManifest(
  routeAccess: RouteAccess | undefined,
  method: string,
  visitorId: string | null | undefined,
  ownerId: string,
  defaultAccess?: ManifestDbAccess,
): boolean {
  const action = METHOD_TO_ACTION[method];
  if (!action) return true;

  if (routeAccess) {
    const level = routeAccess[action] ?? defaultAccess?.[action] ?? "public";
    return checkAccess(level as AccessLevel, visitorId, ownerId, routeAccess.acl);
  }

  const level = defaultAccess?.[action] ?? "public";
  return checkAccess(level as AccessLevel, visitorId, ownerId);
}
