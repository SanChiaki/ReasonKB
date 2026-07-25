import { describe, expect, it } from "vitest";
import { normalizeDocumentUrl } from "@/lib/document-url";

describe("normalizeDocumentUrl", () => {
  it("accepts HTTP links and rejects unsafe or malformed values", () => {
    expect(normalizeDocumentUrl("https://oa.example.test/seeyon/doc.do?docId=1")).toBe(
      "https://oa.example.test/seeyon/doc.do?docId=1",
    );
    expect(normalizeDocumentUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeDocumentUrl("file:///tmp/document.pdf")).toBeNull();
    expect(normalizeDocumentUrl("not a URL")).toBeNull();
  });
});
