import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { listAdminAuditEvents } from "@/lib/repos/source-observability-store";
import { authorizeAdminRequest, unauthorizedAdminResponse } from "@/lib/security/admin-route-auth";

export async function GET(request: Request) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) return unauthorizedAdminResponse();
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "100");
  return NextResponse.json({ events: listAdminAuditEvents(appConfig.dbPath, limit) });
}
