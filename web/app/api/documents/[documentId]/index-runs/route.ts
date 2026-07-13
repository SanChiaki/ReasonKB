import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { isDocumentAccessible, listDocumentIndexRuns } from "@/lib/repos/document-store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await context.params;
  if (!isDocumentAccessible(appConfig.dbPath, documentId)) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({
    runs: listDocumentIndexRuns(appConfig.dbPath, documentId),
  });
}
