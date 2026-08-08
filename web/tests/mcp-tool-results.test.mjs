import { describe, expect, it } from "vitest";
import { retrievalToolContract } from "../mcp-tool-results.mjs";

function baseResult(overrides = {}) {
  return {
    answer: "",
    citations: [],
    selectedDocuments: [],
    evidence: [],
    retrievalStatus: "matched",
    ...overrides,
  };
}

describe("MCP retrieval tool results", () => {
  it("presents Query answers and citations without serializing the full payload", () => {
    const payload = baseResult({
      answer: "Partners must complete final acceptance.",
      citations: [
        {
          evidenceId: "ev-policy",
          projectId: "proj-policy",
          projectName: "Partner policy",
          documentId: "doc-policy",
          documentName: "Policy.xlsx",
          documentUrl: "https://example.test/policy",
          sourceDisplayName: "Policy source",
          sourceKind: "local",
          pages: "3-4",
          focusPage: 3,
          excerpt: "Acceptance is required.",
        },
      ],
      selectedDocuments: [
        {
          documentId: "doc-policy",
          sourceRelativePath: "PRIVATE_SELECTED_PATH",
        },
      ],
    });

    const result = retrievalToolContract("query").present(payload);
    const text = result.content[0].text;

    expect(result.structuredContent).toBe(payload);
    expect(text).toContain("Partners must complete final acceptance.");
    expect(text).toContain("Policy.xlsx");
    expect(text).toContain("Document ID: doc-policy");
    expect(text).toContain("Evidence ID: ev-policy");
    expect(text).toContain("Pages: 3-4");
    expect(text).toContain("Acceptance is required.");
    expect(text).not.toContain("PRIVATE_SELECTED_PATH");
    expect(text).not.toBe(JSON.stringify(payload, null, 2));
  });

  it("keeps Evidence content while excluding structured layout details from text", () => {
    const evidenceContent =
      "Policy evidence\n<table><tr><td>Complete value</td></tr></table>";
    const payload = baseResult({
      selectedDocuments: [{ documentId: "doc-table" }],
      evidence: [
        {
          projectId: "proj-policy",
          projectName: "Partner policy",
          documentId: "doc-table",
          documentName: "Policy table.xlsx",
          documentUrl: "https://example.test/table",
          sourceDisplayName: "Policy source",
          sourceKind: "local",
          sourceRelativePath: "PRIVATE_SOURCE_PATH",
          projectRelativePath: "PRIVATE_PROJECT_PATH",
          pages: "6",
          evidenceKind: "office_pdf_text",
          excerpt: "Duplicate excerpt",
          content: evidenceContent,
          visualAssets: [{ marker: "VISUAL_ASSET_SENTINEL" }],
          pageBlocks: [
            {
              page: 6,
              layoutStatus: "structured",
              blocks: [
                {
                  cells: [{ value: "PAGE_BLOCK_SENTINEL" }],
                  bbox: [0, 1, 2, 3],
                },
              ],
              diagnostics: { marker: "DIAGNOSTICS_SENTINEL" },
            },
          ],
        },
      ],
    });

    const result = retrievalToolContract("evidence").present(payload);
    const text = result.content[0].text;

    expect(result.structuredContent).toEqual(payload);
    expect(text).toContain(evidenceContent);
    expect(text).toContain("Document: Policy table.xlsx");
    expect(text).toContain("Document ID: doc-table");
    expect(text).toContain("Pages: 6");
    expect(text).not.toContain("PAGE_BLOCK_SENTINEL");
    expect(text).not.toContain("DIAGNOSTICS_SENTINEL");
    expect(text).not.toContain("VISUAL_ASSET_SENTINEL");
    expect(text).not.toContain("PRIVATE_SOURCE_PATH");
    expect(text).not.toContain("PRIVATE_PROJECT_PATH");
    expect(text).not.toContain("Duplicate excerpt");
  });

  it("projects EvidenceSet coverage for model-only MCP clients", () => {
    const payload = baseResult({
      coverage: {
        status: "partial",
        confidence: "high",
        aspects: [
          {
            id: "asp-upgrade",
            description: "upgrade application process",
            status: "supported",
            evidenceIds: ["ev-policy"],
          },
          {
            id: "asp-automatic",
            description: "whether the upgrade is automatic",
            status: "unresolved",
            evidenceIds: [],
          },
        ],
        unresolved: ["whether the upgrade is automatic"],
        canContinue: false,
        stopReason: "candidate_exhausted",
      },
    });

    const result = retrievalToolContract("evidence").present(payload);

    expect(result.content[0].text).toContain("Coverage: partial");
    expect(result.content[0].text).toContain(
      "- whether the upgrade is automatic",
    );
    expect(result.content[0].text).toContain("Continuation available: no");
    expect(result.structuredContent.coverage).toEqual(payload.coverage);
  });

  it("substantially reduces a structured-table result without dropping its evidence", () => {
    const cells = Array.from({ length: 200 }, (_, index) => ({
      row: index,
      column: 0,
      value: `STRUCTURED_ONLY_${index}_${"x".repeat(80)}`,
      bbox: [0, index, 100, index + 1],
    }));
    const payload = baseResult({
      selectedDocuments: [{ documentId: "doc-table" }],
      evidence: [
        {
          projectId: "proj-policy",
          projectName: "Partner policy",
          documentId: "doc-table",
          documentName: "Policy table.xlsx",
          pages: "1",
          evidenceKind: "office_pdf_text",
          content: "<table><tr><td>model-visible evidence</td></tr></table>",
          visualAssets: [],
          pageBlocks: [
            {
              page: 1,
              layoutStatus: "structured",
              blocks: [{ cells }],
              diagnostics: {},
            },
          ],
        },
      ],
    });
    const legacyResult = {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
    const result = retrievalToolContract("evidence").present(payload);
    const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

    expect(result.content[0].text).toContain("model-visible evidence");
    expect(bytes(result)).toBeLessThan(bytes(legacyResult) * 0.7);
  });

  it("rejects malformed retrieval results before returning them", () => {
    expect(() =>
      retrievalToolContract("query").outputSchema.parse({
        answer: "Missing fields",
      }),
    ).toThrow();
  });
});
