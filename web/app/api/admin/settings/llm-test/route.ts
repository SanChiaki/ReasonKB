import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import {
  buildLlmModel,
  type LlmInterfaceFormat,
} from "@/lib/llm-model-format";

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
      { message: "LLM base URL must be a valid HTTP or HTTPS URL." },
    )
    .optional(),
  model: z.string().trim().min(1).optional(),
  interfaceFormat: z
    .enum(["openai-compatible", "anthropic-messages"])
    .optional(),
  modelName: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload.", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const model =
    parsed.data.interfaceFormat && parsed.data.modelName
      ? buildLlmModel(
          parsed.data.interfaceFormat as LlmInterfaceFormat,
          parsed.data.modelName,
        )
      : parsed.data.model;
  if (!model) {
    return NextResponse.json(
      {
        error: "Invalid request payload.",
        details: [{ message: "Model name is required." }],
      },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(`${appConfig.retrievalBaseUrl}/internal/llm/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: parsed.data.apiKey || undefined,
        baseUrl: parsed.data.baseUrl,
        model,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          model,
          elapsedMs: 0,
          output: "",
          errorType: "connection",
          message: "Unable to run model test.",
          details: payload?.error ?? `Retrieval API returned ${response.status}.`,
        },
        { status: 200 },
      );
    }
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({
      success: false,
      model,
      elapsedMs: 0,
      output: "",
      errorType: "connection",
      message: "Unable to run model test.",
      details: error instanceof Error ? error.message : "Unknown error.",
    });
  }
}
