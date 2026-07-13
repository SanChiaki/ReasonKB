import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { getDocumentDetail, isDocumentAccessible } from "@/lib/repos/document-store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await context.params;
  if (!isDocumentAccessible(appConfig.dbPath, documentId)) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  const document = getDocumentDetail(appConfig.dbPath, documentId);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  const { storagePath: _storagePath, ...safeDocument } = document;
  return NextResponse.json(safeDocument);
}
