/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
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
});
