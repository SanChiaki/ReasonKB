import { NextResponse } from "next/server";
import { z } from "zod";
import {
  constrainProjectIds,
  isAuthResponse,
  requireAgentAuth,
} from "@/lib/agent-auth";
import { appConfig } from "@/lib/config";
import { sendRetrievalQuery } from "@/lib/retrieval-client";
import { getProjectById } from "@/lib/repos/project-store";

const schema = z.object({
  query: z.string().trim().min(1),
  projectIds: z.array(z.string().trim().min(1)).default([]),
});

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

  const missingProjectIds = projectIds.filter(
    (projectId) => !getProjectById(appConfig.dbPath, projectId),
  );
  if (missingProjectIds.length > 0) {
    return NextResponse.json(
      { error: "One or more projects were not found.", missingProjectIds },
      { status: 404 },
    );
  }

  try {
    const result = await sendRetrievalQuery({
      query: parsed.data.query,
      projectIds,
      mode: "answer",
    });
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
