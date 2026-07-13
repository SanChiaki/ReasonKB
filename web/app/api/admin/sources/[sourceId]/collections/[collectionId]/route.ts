import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import {
  deregisterSourceCollection,
  listSourceCollections,
} from "@/lib/repos/source-collection-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

type RouteContext = {
  params: Promise<{ sourceId: string; collectionId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { sourceId, collectionId } = await context.params;
  if (!listSourceCollections(appConfig.dbPath, sourceId).some((item) => item.id === collectionId)) {
    return NextResponse.json({ error: "Source Collection not found." }, { status: 404 });
  }
  try {
    const removed = deregisterSourceCollection(appConfig.dbPath, collectionId);
    return removed
      ? NextResponse.json({ deregistered: true })
      : NextResponse.json({ error: "Source Collection not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to deregister collection." },
      { status: 409 },
    );
  }
}
