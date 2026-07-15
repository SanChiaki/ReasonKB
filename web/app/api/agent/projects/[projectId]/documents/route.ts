import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  canAccessProject,
  isAuthResponse,
  requireAgentAuth,
} from "@/lib/agent-auth";
import { listDocumentsByProject } from "@/lib/repos/document-store";
import { getProjectById } from "@/lib/repos/project-store";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const auth = requireAgentAuth(request, ["read:documents"]);
  if (isAuthResponse(auth)) {
    return auth;
  }

  const { projectId } = await context.params;
  if (!canAccessProject(projectId, auth)) {
    return NextResponse.json(
      { error: "API key is not allowed to access this project." },
      { status: 403 },
    );
  }

  const project = getProjectById(appConfig.dbPath, projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  return NextResponse.json({
    project,
    documents: listDocumentsByProject(appConfig.dbPath, projectId),
  });
}
