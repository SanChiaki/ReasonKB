import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { isAdminConfigured } from "@/lib/repos/admin-auth-store";
import { authorizeAdminRequest } from "@/lib/security/admin-route-auth";

export async function GET(request: Request) {
  const configured = isAdminConfigured(appConfig.dbPath);
  if (!configured) {
    return NextResponse.json({ configured: false, authenticated: false });
  }
  const session = authorizeAdminRequest(request, appConfig.dbPath);
  return NextResponse.json({
    configured: true,
    authenticated: Boolean(session),
    expiresAt: session?.expiresAt ?? null,
  });
}
