import { NextRequest, NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  canAccessProject,
  isAuthResponse,
  requireAgentAuth,
} from "@/lib/agent-auth";
import {
  getDocumentDetail,
  getDocumentPages,
  InvalidPagesFilterError,
} from "@/lib/repos/document-store";
import { getProjectById } from "@/lib/repos/project-store";

export async function GET(
  request: NextRequest,
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

  try {
    const { storagePath: _storagePath, ...safeDocument } = document;
    return NextResponse.json({
      document: safeDocument,
      pages: getDocumentPages(
        appConfig.dbPath,
        documentId,
        request.nextUrl.searchParams.get("pages"),
      ),
    });
  } catch (error) {
    if (error instanceof InvalidPagesFilterError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to read document pages." }, { status: 500 });
  }
}
