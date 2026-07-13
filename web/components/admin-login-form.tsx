"use client";

import { useState, type FormEvent } from "react";
import { LockKeyhole, LogIn } from "lucide-react";
import { useRouter } from "next/navigation";

export function AdminLoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error ?? "登录失败，请检查管理员密码。");
        return;
      }
      router.replace("/admin/sources");
      router.refresh();
    } catch {
      setError("无法连接到 ReasonKB。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm">
      <div className="mb-8 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-[var(--pi-brand)] text-sm font-semibold text-white">
          RK
        </span>
        <div>
          <h1 className="text-xl font-semibold">ReasonKB 管理</h1>
          <p className="mt-0.5 text-sm text-[var(--pi-muted)]">部署管理员登录</p>
        </div>
      </div>
      <label htmlFor="admin-password" className="text-sm font-medium">
        管理员密码
      </label>
      <div className="relative mt-2">
        <LockKeyhole className="absolute left-3 top-3 text-[var(--pi-muted)]" size={17} />
        <input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-11 w-full rounded-md border border-[var(--pi-border)] bg-white pl-10 pr-3 text-sm outline-none focus:border-[var(--pi-brand)] focus:ring-2 focus:ring-[var(--pi-brand-soft)]"
        />
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-[var(--pi-danger)]">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={submitting}
        className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[var(--pi-brand)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
      >
        <LogIn size={17} aria-hidden="true" />
        {submitting ? "登录中..." : "登录"}
      </button>
    </form>
  );
}
