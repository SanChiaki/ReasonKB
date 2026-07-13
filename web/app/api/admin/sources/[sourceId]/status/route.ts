import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { getSourceRuntimeStatus } from "@/lib/repos/source-observability-store";
import { authorizeAdminRequest, unauthorizedAdminResponse } from "@/lib/security/admin-route-auth";

export async function GET(
  request: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) return unauthorizedAdminResponse();
  const { sourceId } = await context.params;
  const status = getSourceRuntimeStatus(appConfig.dbPath, sourceId);
  return status
    ? NextResponse.json({ status })
    : NextResponse.json({ error: "Corpus Source not found." }, { status: 404 });
}
