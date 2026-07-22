import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import {
  MAX_AGENT_PROJECT_IDS,
  createApiKey,
  listApiKeys,
} from "@/lib/repos/api-key-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

const adminOwnerId = "deployment-admin";

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.string().trim().min(1)).optional(),
  projectIds: z
    .array(z.string().trim().min(1))
    .max(MAX_AGENT_PROJECT_IDS)
    .optional(),
});

export async function GET(request: Request) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) {
    return unauthorizedAdminResponse();
  }
  return NextResponse.json({
    apiKeys: listApiKeys(appConfig.dbPath, adminOwnerId),
  });
}

export async function POST(request: Request) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const apiKey = createApiKey(appConfig.dbPath, {
      ownerUserId: adminOwnerId,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      projectIds: parsed.data.projectIds,
    });
    return NextResponse.json({ apiKey }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create API key." },
      { status: 400 },
    );
  }
}
