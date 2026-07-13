import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { getDocumentDetail, resetDocumentForReindex } from "@/lib/repos/document-store";
import { createIndexJob } from "@/lib/repos/job-store";
import { authorizeAdminRequest, unauthorizedAdminResponse } from "@/lib/security/admin-route-auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { documentId } = await context.params;
  const document = getDocumentDetail(appConfig.dbPath, documentId);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  try {
    const job = createIndexJob(appConfig.dbPath, documentId);
    resetDocumentForReindex(appConfig.dbPath, documentId);
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to queue reindex." },
      { status: 409 },
    );
  }
}
