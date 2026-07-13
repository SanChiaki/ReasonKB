import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { listDocumentsByProject } from "@/lib/repos/document-store";
import { getProjectById } from "@/lib/repos/project-store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  if (!getProjectById(appConfig.dbPath, projectId)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({
    documents: listDocumentsByProject(appConfig.dbPath, projectId),
  });
}
