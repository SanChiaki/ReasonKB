import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  InvalidSourceItemsCursorError,
  listSourceItems,
} from "@/lib/repos/source-observability-store";
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
  const cursor = url.searchParams.get("cursor");
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
    return NextResponse.json({ error: "limit must be an integer from 1 to 500." }, { status: 400 });
  }
  try {
    const result = listSourceItems(appConfig.dbPath, sourceId, {
      collectionId,
      parentId,
      cursor,
      limit,
    });
    return result
      ? NextResponse.json(result)
      : NextResponse.json({ error: "Source Collection not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof InvalidSourceItemsCursorError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
