import { NextResponse } from "next/server";
import { appConfig } from "@/lib/config";
import { revokeApiKey } from "@/lib/repos/api-key-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

const adminOwnerId = "deployment-admin";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ keyId: string }> },
) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { keyId } = await context.params;
  const revoked = revokeApiKey(appConfig.dbPath, {
    ownerUserId: adminOwnerId,
    keyId,
  });
  if (!revoked) {
    return NextResponse.json({ error: "API key not found." }, { status: 404 });
  }
  return NextResponse.json({ revoked: true });
}
