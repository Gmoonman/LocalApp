"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ChangePasswordMode = "force" | "profile";

interface OpenChangePasswordOptions {
  mode: ChangePasswordMode;
  userId?: string;
}

interface OpenLoginOptions {
  returnTo?: string;
}

interface AuthModalsState {
  loginOpen: boolean;
  loginReturnTo: string | null;
  changePasswordOpen: boolean;
  changePasswordMode: ChangePasswordMode;
  changePasswordUserId: string | null;
  pendingOldPassword: string | null;
  openLogin: (options?: OpenLoginOptions) => void;
  closeLogin: () => void;
  restoreLoginFocus: () => void;
  openChangePassword: (options: OpenChangePasswordOptions) => void;
  closeChangePassword: () => void;
  setPendingOldPassword: (password: string | null) => void;
}

const AuthModalsContext = createContext<AuthModalsState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const loginOpener = useRef<HTMLElement | null>(null);
  const restoreLoginFocus = useCallback(() => loginOpener.current?.focus(), []);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginReturnTo, setLoginReturnTo] = useState<string | null>(null);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [changePasswordMode, setChangePasswordMode] =
    useState<ChangePasswordMode>("profile");
  const [changePasswordUserId, setChangePasswordUserId] = useState<
    string | null
  >(null);
  const [pendingOldPassword, setPendingOldPassword] = useState<string | null>(
    null,
  );

  const openLogin = useCallback((options?: OpenLoginOptions) => {
    loginOpener.current =
      typeof document === "undefined"
        ? null
        : (document.activeElement as HTMLElement);
    const currentRoute =
      typeof window === "undefined"
        ? "/"
        : `${window.location.pathname}${window.location.search}${window.location.hash}`;
    setLoginReturnTo(options?.returnTo ?? currentRoute);
    setLoginOpen(true);
  }, []);
  const closeLogin = useCallback(() => setLoginOpen(false), []);
  const openChangePassword = useCallback(
    (options: OpenChangePasswordOptions) => {
      setChangePasswordMode(options.mode);
      setChangePasswordUserId(options.userId ?? null);
      setChangePasswordOpen(true);
    },
    [],
  );
  const closeChangePassword = useCallback(() => {
    setChangePasswordOpen(false);
    setPendingOldPassword(null);
  }, []);

  const value = useMemo<AuthModalsState>(
    () => ({
      loginOpen,
      loginReturnTo,
      changePasswordOpen,
      changePasswordMode,
      changePasswordUserId,
      pendingOldPassword,
      openLogin,
      closeLogin,
      restoreLoginFocus,
      openChangePassword,
      closeChangePassword,
      setPendingOldPassword,
    }),
    [
      loginOpen,
      loginReturnTo,
      changePasswordOpen,
      changePasswordMode,
      changePasswordUserId,
      pendingOldPassword,
      openLogin,
      closeLogin,
      restoreLoginFocus,
      openChangePassword,
      closeChangePassword,
      setPendingOldPassword,
    ],
  );

  return (
    <AuthModalsContext.Provider value={value}>
      {children}
    </AuthModalsContext.Provider>
  );
}

export function useAuthModals(): AuthModalsState {
  const ctx = useContext(AuthModalsContext);
  if (!ctx) {
    throw new Error("useAuthModals must be used within an AuthProvider");
  }
  return ctx;
}
