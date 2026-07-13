import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { getDocumentIndexTree, isDocumentRetrievable } from "@/lib/repos/document-store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await context.params;
  if (!isDocumentRetrievable(appConfig.dbPath, documentId)) {
    return NextResponse.json({ error: "Document index tree not found" }, { status: 404 });
  }
  const tree = getDocumentIndexTree(appConfig.dbPath, documentId);
  if (!tree) {
    return NextResponse.json({ error: "Document index tree not found" }, { status: 404 });
  }
  return NextResponse.json(tree);
}
