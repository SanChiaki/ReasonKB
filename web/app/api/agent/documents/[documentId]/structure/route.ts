import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  canAccessProject,
  isAuthResponse,
  requireAgentAuth,
} from "@/lib/agent-auth";
import {
  getDocumentDetail,
  getDocumentIndexTree,
} from "@/lib/repos/document-store";
import { getProjectById } from "@/lib/repos/project-store";

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const auth = requireAgentAuth(request, ["read:documents"]);
  if (isAuthResponse(auth)) {
    return auth;
  }

  const { documentId } = await context.params;
  const document = getDocumentDetail(appConfig.dbPath, documentId);
  if (!document) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (!getProjectById(appConfig.dbPath, document.projectId)) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (!canAccessProject(document.projectId, auth)) {
    return NextResponse.json(
      { error: "API key is not allowed to access this document." },
      { status: 403 },
    );
  }

  const tree = getDocumentIndexTree(appConfig.dbPath, documentId);
  if (!tree) {
    return NextResponse.json({ error: "Document index tree not found." }, { status: 404 });
  }
  const { storagePath: _storagePath, ...safeDocument } = document;
  return NextResponse.json({ document: safeDocument, tree });
}
