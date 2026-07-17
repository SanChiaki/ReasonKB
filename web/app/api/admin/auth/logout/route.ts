import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { revokeAdminSession } from "@/lib/repos/admin-auth-store";
import {
  adminSessionToken,
  authorizeAdminRequest,
  clearAdminSessionCookie,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

export async function POST(request: Request) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const token = adminSessionToken(request);
  if (token) {
    revokeAdminSession(appConfig.dbPath, token);
  }
  const response = NextResponse.json({ authenticated: false });
  clearAdminSessionCookie(response, request);
  return response;
}
