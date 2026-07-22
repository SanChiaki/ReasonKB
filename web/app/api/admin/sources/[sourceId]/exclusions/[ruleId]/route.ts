import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { deleteSourceExclusion } from "@/lib/repos/source-exclusion-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

type RouteContext = {
  params: Promise<{ sourceId: string; ruleId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { sourceId, ruleId } = await context.params;
  const result = deleteSourceExclusion(appConfig.dbPath, sourceId, ruleId);
  return result
    ? NextResponse.json(result)
    : NextResponse.json({ error: "Source exclusion not found." }, { status: 404 });
}
