import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { getDocumentDetail, resetDocumentForReindex } from "@/lib/repos/document-store";
import { createIndexJob } from "@/lib/repos/job-store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await context.params;
  const document = getDocumentDetail(appConfig.dbPath, documentId);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  resetDocumentForReindex(appConfig.dbPath, documentId);
  const job = createIndexJob(appConfig.dbPath, documentId);
  return NextResponse.json(job, { status: 202 });
}
