/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React, { act } from "react";
import { render, screen } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectGrid } from "@/components/project-grid";

describe("ProjectGrid", () => {
  it("renders folder-like project entries with document counts", () => {
    render(
      <ProjectGrid
        projects={[
          {
            id: "proj_alpha",
            name: "Alpha Knowledge Base",
            documentCount: 12,
            updatedAt: "2026-04-18T12:00:00.000Z",
            source: {
              id: "src_alpha",
              displayName: "Operations share",
              kind: "local",
            },
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("link", { name: /Open Alpha Knowledge Base/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("12 docs")).toBeInTheDocument();
  });

  it("shows an empty state instead of collapsing when there are no projects", () => {
    render(<ProjectGrid projects={[]} />);

    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });

  it("hydrates project dates consistently across server and browser time zones", async () => {
    const previousTimeZone = process.env.TZ;
    const project = {
      id: "proj_boundary",
      name: "Hydration Boundary",
      documentCount: 0,
      updatedAt: "2026-08-03T16:30:00.000Z",
      source: {
        id: "src_boundary",
        displayName: "Boundary source",
        kind: "local" as const,
      },
    };
    let root: Root | undefined;
    let container: HTMLDivElement | undefined;

    try {
      process.env.TZ = "UTC";
      const serverMarkup = renderToString(<ProjectGrid projects={[project]} />);
      container = document.createElement("div");
      container.innerHTML = serverMarkup;
      document.body.append(container);
      process.env.TZ = "Asia/Shanghai";
      const hydrationErrors: Error[] = [];

      await act(async () => {
        root = hydrateRoot(container, <ProjectGrid projects={[project]} />, {
          onRecoverableError(error) {
            hydrationErrors.push(error);
          },
        });
      });

      expect(hydrationErrors).toEqual([]);
      expect(container).toHaveTextContent("Updated Aug 4, 2026");
    } finally {
      await act(async () => root?.unmount());
      container?.remove();
      process.env.TZ = previousTimeZone;
    }
  });
});
