import { appConfig } from "@/lib/config";

export type RetrievalCitation = {
  projectId: string;
  projectName: string;
  documentId: string;
  documentName: string;
  sourceDisplayName?: string | null;
  sourceKind?: string | null;
  pages: string;
  focusPage?: number;
  excerpt?: string;
};

export type RetrievalEvidence = {
  projectId?: string;
  projectName: string;
  documentId?: string;
  documentName: string;
  sourceDisplayName?: string | null;
  sourceKind?: string | null;
  sourceRelativePath?: string | null;
  projectRelativePath?: string | null;
  pages: string;
  evidenceKind: string;
  excerpt?: string | null;
  content: string;
  visualAssets?: Array<Record<string, unknown>>;
};

export type RetrievalMode = "answer" | "evidence";

export type RetrievalResult = {
  answer: string;
  citations: RetrievalCitation[];
  selectedDocuments: Array<{ documentId: string; sourceRelativePath?: string | null }>;
  evidence: RetrievalEvidence[];
};

export type RetrievalProgressEvent = {
  type: "progress";
  stage: string;
  data: Record<string, unknown>;
};

export type RetrievalResultEvent = {
  type: "result";
  data: RetrievalResult;
};

export type RetrievalStreamEvent = RetrievalProgressEvent | RetrievalResultEvent;

export type RetrievalProgressDocument = {
  documentId?: string;
  documentName?: string;
  projectName?: string;
  sourceDisplayName?: string | null;
  sourceKind?: string | null;
  sourceRelativePath?: string | null;
};

export type PersistedRetrievalProgress = {
  kind: "retrieval_progress";
  lines: Array<{
    stage: string;
    data: Record<string, unknown>;
  }>;
  documents: RetrievalProgressDocument[];
};

export function isPersistedRetrievalProgress(
  value: unknown,
): value is PersistedRetrievalProgress {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "retrieval_progress" &&
    Array.isArray(candidate.lines) &&
    Array.isArray(candidate.documents)
  );
}

export async function sendRetrievalQuery(input: {
  query: string;
  projectIds?: string[];
  mode?: RetrievalMode;
}) {
  const response = await fetch(`${appConfig.retrievalBaseUrl}/internal/retrieve/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`retrieval failed with status ${response.status}`);
  }
  return (await response.json()) as RetrievalResult;
}

function parseSseChunk(buffer: string) {
  const events: RetrievalStreamEvent[] = [];
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() ?? "";

  for (const part of parts) {
    const dataLines = part
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));
    if (dataLines.length === 0) {
      continue;
    }
    events.push(JSON.parse(dataLines.join("\n")) as RetrievalStreamEvent);
  }

  return { events, remainder };
}

export async function sendRetrievalQueryStream(
  input: {
    query: string;
    projectIds?: string[];
    mode?: RetrievalMode;
  },
  onEvent: (event: RetrievalStreamEvent) => void,
) {
  const response = await fetch(`${appConfig.retrievalBaseUrl}/internal/retrieve/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    throw new Error(`retrieval stream failed with status ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: RetrievalResult | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.remainder;
    for (const event of parsed.events) {
      onEvent(event);
      if (event.type === "result") {
        result = event.data;
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseChunk(`${buffer}\n\n`);
    for (const event of parsed.events) {
      onEvent(event);
      if (event.type === "result") {
        result = event.data;
      }
    }
  }

  if (!result) {
    throw new Error("retrieval stream ended without a result event");
  }
  return result;
}
