"use client";

import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { readAdminCsrfToken } from "@/components/admin-shell";
import { useI18n } from "@/lib/i18n";

type PasswordResponse = {
  code?: string;
  error?: string;
};

export function AdminPasswordForm() {
  const { t } = useI18n();
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const passwordsMatch = newPassword === confirmation;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= 12 &&
    newPassword.length <= 1024 &&
    passwordsMatch &&
    currentPassword !== newPassword &&
    !submitting;

  function clearError() {
    setErrorMessage("");
  }

  function messageForError(payload: PasswordResponse | null) {
    switch (payload?.code) {
      case "invalid_current_password":
        return t("settings.passwordCurrentIncorrect");
      case "password_unchanged":
        return t("settings.passwordMustDiffer");
      case "invalid_password":
        return t("settings.passwordRequirements");
      default:
        return t("settings.passwordChangeError");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    setSubmitting(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/admin/auth/password", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-reasonkb-csrf": readAdminCsrfToken(),
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const payload = (await response.json().catch(() => null)) as PasswordResponse | null;
      if (!response.ok) {
        setErrorMessage(messageForError(payload));
        return;
      }
      router.replace("/admin/login?passwordChanged=1");
      router.refresh();
    } catch {
      setErrorMessage(t("settings.passwordChangeError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-[var(--pi-border)] bg-white p-5"
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
            {t("settings.securityEyebrow")}
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
            {t("settings.changeAdminPassword")}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
            {t("settings.passwordDescription")}
          </p>
        </div>

        <div className="grid w-full gap-4 lg:w-[28rem]">
          <div>
            <label
              htmlFor="current-admin-password"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              {t("settings.currentPassword")}
            </label>
            <input
              id="current-admin-password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                clearError();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
            />
          </div>
          <div>
            <label
              htmlFor="new-admin-password"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              {t("settings.newPassword")}
            </label>
            <input
              id="new-admin-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={1024}
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
                clearError();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
            />
            <p className="mt-2 text-xs text-[var(--pi-muted)]">
              {t("settings.passwordRequirements")}
            </p>
          </div>
          <div>
            <label
              htmlFor="confirm-admin-password"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              {t("settings.confirmPassword")}
            </label>
            <input
              id="confirm-admin-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={1024}
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
                clearError();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
            />
            {confirmation && !passwordsMatch ? (
              <p className="mt-2 text-xs text-[var(--pi-danger)]">
                {t("settings.passwordMismatch")}
              </p>
            ) : null}
          </div>
          {currentPassword && newPassword && currentPassword === newPassword ? (
            <p className="text-sm text-[var(--pi-danger)]">
              {t("settings.passwordMustDiffer")}
            </p>
          ) : null}
          {errorMessage ? (
            <p role="alert" className="text-sm text-[var(--pi-danger)]">
              {errorMessage}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 sm:justify-self-start"
          >
            <KeyRound aria-hidden="true" className="h-4 w-4" />
            {submitting
              ? t("settings.passwordChanging")
              : t("settings.changePassword")}
          </button>
        </div>
      </div>
    </form>
  );
}
