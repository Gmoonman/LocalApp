export function resolveAuthReturnTo(returnTo: string | null): string {
  if (!returnTo) return "/";

  try {
    const target = new URL(returnTo, window.location.origin);
    if (target.origin !== window.location.origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

/** Reload same-document returns too, so the page reads the new session cookie. */
export function navigateAfterLogin(returnTo: string | null): void {
  const target = resolveAuthReturnTo(returnTo);
  const current = new URL(window.location.href);
  const destination = new URL(target, current);
  if (destination.pathname === current.pathname && destination.search === current.search) {
    window.history.replaceState(window.history.state, "", target);
    window.location.reload();
  } else {
    window.location.href = target;
  }
}
