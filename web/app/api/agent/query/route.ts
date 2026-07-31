import { NextResponse } from "next/server";
import { z } from "zod";
import {
  constrainProjectIds,
  isAuthResponse,
  requireAgentAuth,
} from "@/lib/agent-auth";
import { appConfig } from "@/lib/config";
import {
  openRetrievalQueryStream,
  projectAgentRetrievalStream,
  sendRetrievalQueryStream,
} from "@/lib/retrieval-client";
import { MAX_AGENT_PROJECT_IDS } from "@/lib/repos/api-key-store";
import { findUnavailableProjectIds } from "@/lib/repos/project-store";

const schema = z.object({
  query: z.string().trim().min(1),
  projectIds: z
    .array(z.string().trim().min(1))
    .max(MAX_AGENT_PROJECT_IDS)
    .default([]),
});

function acceptsEventStream(request: Request) {
  return request.headers
    .get("accept")
    ?.split(",")
    .some(
      (value) => value.trim().split(";", 1)[0]?.toLowerCase() === "text/event-stream",
    );
}

export async function POST(request: Request) {
  const auth = requireAgentAuth(request, ["query"]);
  if (isAuthResponse(auth)) {
    return auth;
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const projectIds = constrainProjectIds(parsed.data.projectIds, auth);
  if (!Array.isArray(projectIds)) {
    return NextResponse.json(projectIds, { status: 403 });
  }

  const missingProjectIds = findUnavailableProjectIds(appConfig.dbPath, projectIds);
  if (missingProjectIds.length > 0) {
    return NextResponse.json(
      { error: "One or more projects were not found.", missingProjectIds },
      { status: 404 },
    );
  }

  try {
    const input = {
      query: parsed.data.query,
      projectIds,
      mode: "answer" as const,
    };
    if (acceptsEventStream(request)) {
      const body = projectAgentRetrievalStream(
        await openRetrievalQueryStream(input, request.signal),
        "answer",
      );
      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }
    const result = await sendRetrievalQueryStream(
      input,
      () => {},
      request.signal,
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Retrieval failed.",
        details: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 502 },
    );
  }
}
