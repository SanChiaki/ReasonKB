/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppShell } from "@/components/app-shell";

const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

describe("AppShell", () => {
  beforeEach(() => {
    if (localStorageDescriptor) {
      Object.defineProperty(window, "localStorage", localStorageDescriptor);
    }
    window.localStorage.clear();
  });

  afterEach(() => {
    if (localStorageDescriptor) {
      Object.defineProperty(window, "localStorage", localStorageDescriptor);
    }
  });

  it("defaults to Chinese navigation and persists an English switch", async () => {
    const { unmount } = render(
      <AppShell conversations={[]}>
        <div>内容区域</div>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: /新建对话/ })).toHaveAttribute("href", "/chat");
    expect(screen.getByRole("link", { name: /^项目$/ })).toHaveAttribute("href", "/projects");
    expect(screen.getByRole("link", { name: /^设置$/ })).toHaveAttribute("href", "/settings");

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByRole("link", { name: /new chat/i })).toHaveAttribute("href", "/chat");
    expect(window.localStorage.getItem("reasonkb.locale")).toBe("en");

    unmount();
    render(
      <AppShell conversations={[]}>
        <div>Content area</div>
      </AppShell>,
    );

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /new chat/i })).toHaveAttribute("href", "/chat");
    });
    expect(screen.getByRole("link", { name: /^projects$/i })).toHaveAttribute("href", "/projects");
  });

  it("switches language when locale storage is unavailable", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage is blocked");
      },
    });

    render(
      <AppShell conversations={[]}>
        <div>内容区域</div>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: /新建对话/ })).toHaveAttribute("href", "/chat");

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByRole("link", { name: /new chat/i })).toHaveAttribute("href", "/chat");
  });

  it("renders content with a mobile navigation trigger", () => {
    render(
      <AppShell conversations={[]}>
        <div>Projects content</div>
      </AppShell>,
    );

    const main = screen.getByRole("main");
    expect(main).toHaveTextContent("Projects content");

    fireEvent.click(screen.getByRole("button", { name: /打开导航/ }));

    expect(screen.getAllByRole("button", { name: /关闭导航/ }).length).toBeGreaterThan(
      0,
    );
  });

  it("locks scrolling to the interior panes", () => {
    render(
      <AppShell conversations={[]}>
        <div data-testid="content-pane">Projects content</div>
      </AppShell>,
    );

    const main = screen.getByRole("main");
    expect(main).toHaveClass("overflow-hidden");
    expect(main.parentElement).toHaveClass("h-dvh", "overflow-hidden");
    expect(screen.getByTestId("content-pane").parentElement).toHaveClass("overflow-hidden");
  });
});
