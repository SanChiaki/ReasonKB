import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { listSourceItems } from "@/lib/repos/source-observability-store";
import { authorizeAdminRequest, unauthorizedAdminResponse } from "@/lib/security/admin-route-auth";

export async function GET(
  request: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) return unauthorizedAdminResponse();
  const { sourceId } = await context.params;
  const url = new URL(request.url);
  const collectionId = url.searchParams.get("collectionId")?.trim();
  if (!collectionId) {
    return NextResponse.json({ error: "collectionId is required." }, { status: 400 });
  }
  const parentId = url.searchParams.get("parentId");
  const items = listSourceItems(appConfig.dbPath, sourceId, { collectionId, parentId });
  return items
    ? NextResponse.json({ items })
    : NextResponse.json({ error: "Source Collection not found." }, { status: 404 });
}
