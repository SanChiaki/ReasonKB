import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import {
  getSystemSettings,
  updateSystemSettings,
} from "@/lib/repos/system-settings-store";

const schema = z.object({
  indexWorkerConcurrency: z.number().int().min(1).max(16).optional(),
  retrievalDocumentLimit: z.number().int().min(1).max(50).optional(),
});

const defaults = {
  indexWorkerConcurrency: Number.parseInt(
    process.env.INDEX_WORKER_CONCURRENCY ?? "1",
    10,
  ),
  retrievalDocumentLimit: 5,
};

export async function GET() {
  return NextResponse.json({
    settings: getSystemSettings(appConfig.dbPath, defaults),
  });
}

export async function PATCH(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }

  return NextResponse.json({
    settings: updateSystemSettings(appConfig.dbPath, parsed.data, defaults),
  });
}
