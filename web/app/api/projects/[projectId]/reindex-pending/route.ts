import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { reindexPendingDocumentsByProject } from "@/lib/repos/job-store";
import { getProjectById } from "@/lib/repos/project-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { projectId } = await context.params;
  if (!getProjectById(appConfig.dbPath, projectId)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  try {
    const result = reindexPendingDocumentsByProject(appConfig.dbPath, projectId);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to queue pending documents." },
      { status: 409 },
    );
  }
}
