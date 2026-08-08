import { z } from "zod";

const optionalString = z.string().nullable().optional();
const openObject = z.record(z.unknown());

const citationSchema = z
  .object({
    evidenceId: z.string().optional(),
    projectId: z.string(),
    projectName: z.string(),
    documentId: z.string(),
    documentName: z.string(),
    documentUrl: optionalString,
    sourceDisplayName: optionalString,
    sourceKind: optionalString,
    pages: z.string(),
    focusPage: z.number().int().nullable().optional(),
    excerpt: optionalString,
  })
  .passthrough();

const selectedDocumentSchema = z
  .object({
    documentId: z.string(),
    sourceRelativePath: optionalString,
  })
  .passthrough();

const pageBlockSchema = z
  .object({
    page: z.number().int(),
    layoutStatus: z.enum([
      "no_table",
      "structured",
      "ambiguous",
      "visual_only",
    ]),
    blocks: z.array(openObject),
    diagnostics: openObject,
  })
  .passthrough();

const evidenceItemSchema = z
  .object({
    evidenceId: z.string().optional(),
    projectId: z.string(),
    projectName: z.string(),
    documentId: z.string(),
    documentName: z.string(),
    documentUrl: optionalString,
    sourceDisplayName: optionalString,
    sourceKind: optionalString,
    sourceRelativePath: optionalString,
    projectRelativePath: optionalString,
    pages: z.string(),
    evidenceKind: z.string(),
    excerpt: optionalString,
    content: z.string(),
    visualAssets: z.array(openObject),
    pageBlocks: z.array(pageBlockSchema).optional(),
    supports: z.array(z.string()).optional(),
  })
  .passthrough();

const coverageAspectSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    status: z.enum(["supported", "unresolved"]),
    evidenceIds: z.array(z.string()),
  })
  .passthrough();

const coverageSchema = z
  .object({
    status: z.enum(["complete", "partial", "none", "unknown"]),
    confidence: z.enum(["high", "medium", "low"]),
    aspects: z.array(coverageAspectSchema),
    unresolved: z.array(z.string()),
    canContinue: z.boolean(),
    stopReason: z.string(),
  })
  .passthrough();

const retrievalResultSchema = z
  .object({
    answer: z.string(),
    citations: z.array(citationSchema),
    selectedDocuments: z.array(selectedDocumentSchema),
    evidence: z.array(evidenceItemSchema),
    retrievalStatus: z.enum(["matched", "no_match", "degraded"]),
    degradedReason: z.string().optional(),
    coverage: coverageSchema.optional(),
  })
  .passthrough();

function singleLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

function appendOptionalLine(lines, label, value, indent = "") {
  if (typeof value === "string" && value.trim()) {
    lines.push(`${indent}${label}: ${singleLine(value)}`);
  }
}

function statusLines(payload) {
  const lines = [`Retrieval status: ${payload.retrievalStatus}`];
  appendOptionalLine(lines, "Degraded reason", payload.degradedReason);
  if (payload.coverage) {
    lines.push(`Coverage: ${payload.coverage.status}`);
    if (payload.coverage.unresolved.length > 0) {
      lines.push("Unresolved coverage:");
      payload.coverage.unresolved.forEach((aspect) => {
        lines.push(`- ${singleLine(aspect)}`);
      });
    }
    lines.push(
      `Continuation available: ${payload.coverage.canContinue ? "yes" : "no"}`,
    );
  }
  return lines;
}

function queryText(payload) {
  const lines = statusLines(payload);
  lines.push("", "Answer", payload.answer);

  if (payload.citations.length === 0) {
    lines.push("", "No citations were returned.");
    return lines.join("\n");
  }

  lines.push("", "Citations");
  payload.citations.forEach((citation, index) => {
    lines.push(`${index + 1}. ${singleLine(citation.documentName)}`);
    appendOptionalLine(lines, "Evidence ID", citation.evidenceId, "   ");
    lines.push(`   Document ID: ${singleLine(citation.documentId)}`);
    lines.push(`   Project: ${singleLine(citation.projectName)}`);
    appendOptionalLine(
      lines,
      "Source",
      citation.sourceDisplayName,
      "   ",
    );
    lines.push(`   Pages: ${singleLine(citation.pages)}`);
    appendOptionalLine(lines, "URL", citation.documentUrl, "   ");
    if (typeof citation.excerpt === "string" && citation.excerpt) {
      lines.push("   Excerpt:", citation.excerpt);
    }
  });
  return lines.join("\n");
}

function evidenceText(payload) {
  const lines = statusLines(payload);
  if (payload.evidence.length === 0) {
    lines.push("", "No evidence was returned.");
    return lines.join("\n");
  }

  payload.evidence.forEach((evidence, index) => {
    lines.push("", `Evidence ${index + 1}`);
    lines.push(`Document: ${singleLine(evidence.documentName)}`);
    lines.push(`Document ID: ${singleLine(evidence.documentId)}`);
    lines.push(`Project: ${singleLine(evidence.projectName)}`);
    appendOptionalLine(lines, "Source", evidence.sourceDisplayName);
    lines.push(`Pages: ${singleLine(evidence.pages)}`);
    lines.push(`Kind: ${singleLine(evidence.evidenceKind)}`);
    appendOptionalLine(lines, "URL", evidence.documentUrl);
    lines.push("", evidence.content);
  });
  return lines.join("\n");
}

const RETRIEVAL_TOOL_CONTRACTS = Object.freeze({
  query: Object.freeze({
    outputSchema: retrievalResultSchema,
    toText: queryText,
  }),
  evidence: Object.freeze({
    outputSchema: retrievalResultSchema,
    toText: evidenceText,
  }),
});

export function retrievalToolContract(kind) {
  const contract = RETRIEVAL_TOOL_CONTRACTS[kind];
  if (!contract) {
    throw new Error(`Unsupported retrieval tool result kind: ${kind}`);
  }
  return {
    outputSchema: contract.outputSchema,
    present(payload) {
      return {
        content: [{ type: "text", text: contract.toText(payload) }],
        structuredContent: payload,
      };
    },
  };
}
