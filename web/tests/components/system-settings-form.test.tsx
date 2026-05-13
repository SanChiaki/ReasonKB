/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemSettingsForm } from "@/components/system-settings-form";

const routerMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

afterEach(() => {
  vi.restoreAllMocks();
  routerMocks.refresh.mockClear();
});

describe("SystemSettingsForm", () => {
  it("saves index worker concurrency", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ settings: { indexWorkerConcurrency: 4 } })));

    render(<SystemSettingsForm initialIndexWorkerConcurrency={2} />);
    fireEvent.change(screen.getByLabelText(/concurrent jobs/i), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ indexWorkerConcurrency: 4 }),
      }),
    );
    expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/settings saved/i)).toBeInTheDocument();
  });
});
