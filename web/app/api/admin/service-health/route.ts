import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { collectServiceHealth } from "@/lib/service-health";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) {
    return unauthorizedAdminResponse();
  }
  return NextResponse.json(await collectServiceHealth(appConfig.serviceHealth));
}
