import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import {
  authorizeAdminRequest,
  unauthorizedAdminResponse,
} from "@/lib/security/admin-route-auth";

const schema = z.object({
  apiKey: z.string().trim().optional(),
  baseUrl: z
    .string()
    .trim()
    .refine(
      (value) => {
        if (!value) {
          return true;
        }
        try {
          const url = new URL(value);
          return ["http:", "https:"].includes(url.protocol);
        } catch {
          return false;
        }
      },
      { message: "Embedding base URL must be a valid HTTP or HTTPS URL." },
    )
    .optional(),
  model: z.string().trim().min(1),
});

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
    const response = await fetch(
      `${appConfig.retrievalBaseUrl}/internal/embedding/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json({
        success: false,
        model: parsed.data.model,
        dimension: 0,
        promptTokens: 0,
        elapsedMs: 0,
        errorType: "connection",
        message: "Unable to run embedding model test.",
        details: payload?.error ?? `Retrieval API returned ${response.status}.`,
      });
    }
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({
      success: false,
      model: parsed.data.model,
      dimension: 0,
      promptTokens: 0,
      elapsedMs: 0,
      errorType: "connection",
      message: "Unable to run embedding model test.",
      details: error instanceof Error ? error.message : "Unknown error.",
    });
  }
}
