import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import { getCorpusSource } from "@/lib/repos/corpus-source-store";
import {
  listSourceCollections,
  registerSeeyonCollection,
} from "@/lib/repos/source-collection-store";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

const opaqueIntegerId = z
  .string()
  .trim()
  .regex(/^-?\d+$/, "Seeyon IDs must be signed integer strings.")
  .max(32);

const registrationSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    docLibId: opaqueIntegerId,
    rootArchiveId: opaqueIntegerId,
  })
  .strict();

type RouteContext = { params: Promise<{ sourceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath)) {
    return unauthorizedAdminResponse();
  }
  const { sourceId } = await context.params;
  const source = getCorpusSource(appConfig.dbPath, sourceId);
  if (!source) {
    return NextResponse.json({ error: "Corpus Source not found." }, { status: 404 });
  }
  return NextResponse.json({
    selectionPolicy: source.selectionPolicy,
    collections: listSourceCollections(appConfig.dbPath, sourceId),
  });
}

export async function POST(request: Request, context: RouteContext) {
  if (!authorizeAdminRequest(request, appConfig.dbPath, { requireCsrf: true })) {
    return unauthorizedAdminResponse();
  }
  const { sourceId } = await context.params;
  const parsed = registrationSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const collection = registerSeeyonCollection(
      appConfig.dbPath,
      sourceId,
      parsed.data,
    );
    return NextResponse.json({ collection }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to register collection.";
    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message.includes("already registered")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
