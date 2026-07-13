import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import { setCollectionSelectionPolicy } from "@/lib/repos/source-collection-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

const schema = z
  .object({
    policy: z.enum(["none", "explicit", "all"]),
    collectionIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

type RouteContext = { params: Promise<{ sourceId: string }> };

export async function PUT(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { sourceId } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }
  if (parsed.data.policy !== "explicit" && parsed.data.collectionIds !== undefined) {
    return NextResponse.json(
      { error: "collectionIds may only be supplied for the Explicit policy." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      setCollectionSelectionPolicy(
        appConfig.dbPath,
        sourceId,
        parsed.data.policy,
        parsed.data.collectionIds,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update selection.";
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 400 },
    );
  }
}
