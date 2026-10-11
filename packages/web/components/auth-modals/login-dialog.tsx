"use client";

import { type FormEvent, useState } from "react";
import { LogIn } from "lucide-react";
import { useAuthModals } from "./auth-provider";
import { resolveAuthReturnTo } from "./auth-return";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginDialog() {
  const {
    loginOpen,
    loginReturnTo,
    closeLogin,
    openChangePassword,
    setPendingOldPassword,
    restoreLoginFocus,
    changePasswordOpen,
  } = useAuthModals();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") || "");
    const password = String(form.get("password") || "");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "include",
      });
      const body = await response.json();
      if (!body.success) {
        if (body.code === "MUST_CHANGE_PASSWORD") {
          setPendingOldPassword(password);
          closeLogin();
          openChangePassword({ mode: "force", userId: username });
          return;
        }
        setError(body.error || "登录失败");
        return;
      }
      window.location.href = resolveAuthReturnTo(loginReturnTo);
    } catch {
      setError("网络错误，请重试。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={loginOpen}
      onOpenChange={(open) => {
        if (!open) closeLogin();
      }}
    >
      <DialogContent
        closeLabel="关闭登录"
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!changePasswordOpen) restoreLoginFocus?.();
        }}
      >
        <div className="mb-6 space-y-2 pr-6">
          <DialogTitle className="text-xl font-semibold">欢迎回来</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            登录后，继续使用和创建你的应用。
          </DialogDescription>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="auth-login-username">用户名或邮箱</Label>
            <Input
              id="auth-login-username"
              name="username"
              autoComplete="username"
              required
              placeholder="请输入用户名或邮箱"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="auth-login-password">密码</Label>
            <Input
              id="auth-login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="请输入密码"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={loading} className="w-full">
            <LogIn size={16} />
            {loading ? "登录中..." : "登录"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
