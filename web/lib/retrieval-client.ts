import { appConfig } from "@/lib/config";

export type RetrievalCitation = {
  projectId: string;
  projectName: string;
  documentId: string;
  documentName: string;
  documentUrl?: string | null;
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
  documentUrl?: string | null;
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
  retrievalStatus?: "matched" | "no_match" | "degraded";
  degradedReason?: string;
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
  documentUrl?: string | null;
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

export async function sendRetrievalQuery(
  input: {
    query: string;
    projectIds?: string[];
    mode?: RetrievalMode;
  },
  signal?: AbortSignal,
) {
  const response = await fetch(`${appConfig.retrievalBaseUrl}/internal/retrieve/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`retrieval failed with status ${response.status}`);
  }
  return (await response.json()) as RetrievalResult;
}

type SseFrameState = {
  buffer: string;
  scanFrom: number;
};

function takeCompleteSseFrames(state: SseFrameState) {
  const frames: string[] = [];
  let scanFrom = Math.max(0, state.scanFrom);

  while (true) {
    let frameEnd = -1;
    let nextFrameStart = -1;
    for (let index = scanFrom; index < state.buffer.length; index += 1) {
      if (state.buffer.charCodeAt(index) !== 10) {
        continue;
      }
      let secondNewline = index + 1;
      if (state.buffer.charCodeAt(secondNewline) === 13) {
        secondNewline += 1;
      }
      if (state.buffer.charCodeAt(secondNewline) !== 10) {
        continue;
      }
      frameEnd =
        index > 0 && state.buffer.charCodeAt(index - 1) === 13 ? index - 1 : index;
      nextFrameStart = secondNewline + 1;
      break;
    }

    if (nextFrameStart < 0) {
      state.scanFrom = Math.max(0, state.buffer.length - 2);
      return frames;
    }

    frames.push(state.buffer.slice(0, frameEnd));
    state.buffer = state.buffer.slice(nextFrameStart);
    scanFrom = 0;
  }
}

function parseSseChunk(state: SseFrameState) {
  const events: RetrievalStreamEvent[] = [];

  for (const part of takeCompleteSseFrames(state)) {
    const dataLines = part
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (dataLines.length === 0) {
      continue;
    }
    const data = dataLines.join("\n");
    if (data.trim()) {
      events.push(JSON.parse(data) as RetrievalStreamEvent);
    }
  }

  return events;
}

type ParsedAgentSseFrame =
  | { kind: "event"; event: unknown }
  | { kind: "comment"; value: string };

function parseAgentSseFrames(state: SseFrameState) {
  const frames: ParsedAgentSseFrame[] = [];

  for (const part of takeCompleteSseFrames(state)) {
    const lines = part.split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    const data = dataLines.join("\n");
    if (data.trim()) {
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        throw new Error("ReasonKB returned malformed retrieval stream data.");
      }
      frames.push({ kind: "event", event });
      continue;
    }
    if (lines.some((line) => line.startsWith(":"))) {
      frames.push({ kind: "comment", value: part });
    }
  }

  return frames;
}

const AGENT_PROGRESS_FIELDS: Record<string, readonly string[]> = {
  retrieval_started: ["mode"],
  documents_loaded: ["documentCount"],
  document_selection_started: ["documentCount", "limit"],
  documents_selected: [
    "documentCount",
    "selectionStrategy",
    "modelOutcome",
    "elapsedMs",
  ],
  evidence_started: ["documentCount", "documentConcurrency", "initialDocumentCount"],
  evidence_wave_started: ["wave", "documentCount", "remainingDocumentCount"],
  evidence_wave_completed: [
    "wave",
    "attemptedDocumentCount",
    "evidenceDocumentCount",
    "remainingDocumentCount",
  ],
  evidence_validation_started: ["wave", "documentCount"],
  evidence_validation_completed: [
    "wave",
    "attemptedCount",
    "acceptedCount",
    "retrievalStatus",
  ],
  evidence_coverage_started: ["wave", "evidenceDocumentCount", "remainingDocumentCount"],
  evidence_coverage_completed: [
    "wave",
    "coverage",
    "confidence",
    "evidenceDocumentCount",
    "remainingDocumentCount",
  ],
  document_evidence_loaded: ["evidenceCount"],
  document_evidence_pending_validation: ["evidenceCount"],
  document_evidence_skipped: ["reason"],
  answer_generation_started: ["evidenceDocumentCount"],
  answer_generation_completed: ["citationCount"],
  retrieval_completed: ["documentCount", "retrievalStatus", "elapsedMs"],
};

/** Keep internal document summaries and excerpts out of Agent progress streams. */
export function projectAgentRetrievalEvent(
  event: unknown,
  _mode: RetrievalMode = "answer",
): RetrievalStreamEvent | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const candidate = event as Record<string, unknown>;
  if (candidate.type === "result") {
    if (
      !candidate.data ||
      typeof candidate.data !== "object" ||
      Array.isArray(candidate.data)
    ) {
      throw new Error("ReasonKB returned an invalid retrieval result event.");
    }
    return candidate as RetrievalResultEvent;
  }
  if (candidate.type !== "progress" || typeof candidate.stage !== "string") {
    return null;
  }
  const data =
    candidate.data && typeof candidate.data === "object"
      ? (candidate.data as Record<string, unknown>)
      : {};
  const allowedFields = AGENT_PROGRESS_FIELDS[candidate.stage] ?? [];
  const projectedData = Object.fromEntries(
    allowedFields
      .filter((field) => Object.prototype.hasOwnProperty.call(data, field))
      .map((field) => [field, data[field]]),
  );
  return {
    type: "progress",
    stage: candidate.stage,
    data: projectedData,
  };
}

export function projectAgentRetrievalStream(
  body: ReadableStream<Uint8Array>,
  mode: RetrievalMode = "answer",
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parserState: SseFrameState = { buffer: "", scanFrom: 0 };
  const encodeFrame = (frame: ParsedAgentSseFrame) => {
    if (frame.kind === "comment") {
      return encoder.encode(`${frame.value}\n\n`);
    }
    const projected = projectAgentRetrievalEvent(frame.event, mode);
    return projected
      ? encoder.encode(`data: ${JSON.stringify(projected)}\n\n`)
      : null;
  };
  const emitFrames = (
    frames: ParsedAgentSseFrame[],
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    for (const frame of frames) {
      const encoded = encodeFrame(frame);
      if (encoded) {
        controller.enqueue(encoded);
      }
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        parserState.buffer += decoder.decode(chunk, { stream: true });
        emitFrames(parseAgentSseFrames(parserState), controller);
      },
      flush(controller) {
        parserState.buffer += decoder.decode();
        if (!parserState.buffer.trim()) {
          return;
        }
        parserState.buffer += "\n\n";
        emitFrames(parseAgentSseFrames(parserState), controller);
      },
    }),
  );
}

export async function openRetrievalQueryStream(
  input: {
    query: string;
    projectIds?: string[];
    mode?: RetrievalMode;
  },
  signal?: AbortSignal,
) {
  const response = await fetch(`${appConfig.retrievalBaseUrl}/internal/retrieve/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    throw new Error(`retrieval stream failed with status ${response.status}`);
  }

  return response.body;
}

export async function sendRetrievalQueryStream(
  input: {
    query: string;
    projectIds?: string[];
    mode?: RetrievalMode;
  },
  onEvent: (event: RetrievalStreamEvent) => void,
  signal?: AbortSignal,
) {
  const body = await openRetrievalQueryStream(input, signal);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parserState: SseFrameState = { buffer: "", scanFrom: 0 };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parserState.buffer += decoder.decode(value, { stream: true });
      for (const event of parseSseChunk(parserState)) {
        onEvent(event);
        if (event.type === "result") {
          return event.data;
        }
      }
    }

    parserState.buffer += decoder.decode();
    if (parserState.buffer.trim()) {
      parserState.buffer += "\n\n";
      for (const event of parseSseChunk(parserState)) {
        onEvent(event);
        if (event.type === "result") {
          return event.data;
        }
      }
    }

    throw new Error("retrieval stream ended without a result event");
  } finally {
    await reader.cancel("retrieval stream processing finished").catch(() => {});
    reader.releaseLock();
  }
}
