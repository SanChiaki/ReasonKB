import { NextRequest, NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  getDocumentPages,
  InvalidPagesFilterError,
  isDocumentRetrievable,
} from "@/lib/repos/document-store";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await context.params;
  if (!isDocumentRetrievable(appConfig.dbPath, documentId)) {
    return NextResponse.json({ error: "Document pages not found" }, { status: 404 });
  }
  const pages = request.nextUrl.searchParams.get("pages");
  try {
    return NextResponse.json({
      pages: getDocumentPages(appConfig.dbPath, documentId, pages),
    });
  } catch (error) {
    if (error instanceof InvalidPagesFilterError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to read document pages." }, { status: 500 });
  }
}
