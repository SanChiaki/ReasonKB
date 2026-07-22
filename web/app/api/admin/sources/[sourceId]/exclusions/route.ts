import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import {
  createSourceExclusion,
  listSourceExclusions,
} from "@/lib/repos/source-exclusion-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

const schema = z.discriminatedUnion("targetType", [
  z
    .object({
      targetType: z.literal("collection"),
      collectionId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      targetType: z.literal("item"),
      sourceItemId: z.string().trim().min(1),
    })
    .strict(),
]);

type RouteContext = { params: Promise<{ sourceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) {
    return unauthorizedAdminResponse();
  }
  const { sourceId } = await context.params;
  const exclusions = listSourceExclusions(appConfig.dbPath, sourceId);
  return exclusions
    ? NextResponse.json({ exclusions })
    : NextResponse.json({ error: "Corpus Source not found." }, { status: 404 });
}

export async function POST(request: Request, context: RouteContext) {
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
  const { sourceId } = await context.params;
  try {
    return NextResponse.json(
      createSourceExclusion(appConfig.dbPath, sourceId, parsed.data),
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create exclusion.";
    return NextResponse.json(
      { error: message },
      {
        status: message.includes("not found")
          ? 404
          : message.includes("already excluded")
            ? 409
            : 400,
      },
    );
  }
}
