/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPasswordForm } from "@/components/admin-password-form";
import { I18nProvider } from "@/lib/i18n";

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("@/components/admin-shell", () => ({
  readAdminCsrfToken: () => "csrf-token",
}));

function renderForm() {
  return render(
    <I18nProvider>
      <AdminPasswordForm />
    </I18nProvider>,
  );
}

function fillPasswords({
  current = "initial admin password",
  next = "replacement admin password",
  confirmation = next,
}: {
  current?: string;
  next?: string;
  confirmation?: string;
} = {}) {
  fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("新密码"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("确认新密码"), {
    target: { value: confirmation },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  routerMocks.replace.mockReset();
  routerMocks.refresh.mockReset();
  window.localStorage.clear();
});

describe("AdminPasswordForm", () => {
  it("requires matching new passwords before submission", () => {
    renderForm();
    fillPasswords({ confirmation: "different admin password" });

    expect(screen.getByText("两次输入的新密码不一致。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修改密码" })).toBeDisabled();
  });

  it("shows an incorrect-current-password response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "invalid_current_password",
          error: "The current password is incorrect.",
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    fillPasswords();

    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("当前密码不正确。");
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("submits with CSRF protection and returns to login after success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ changed: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    fillPasswords();

    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/auth/password", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-reasonkb-csrf": "csrf-token",
      },
      body: JSON.stringify({
        currentPassword: "initial admin password",
        newPassword: "replacement admin password",
      }),
    });
    expect(routerMocks.replace).toHaveBeenCalledWith(
      "/admin/login?passwordChanged=1",
    );
    expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
  });
});
