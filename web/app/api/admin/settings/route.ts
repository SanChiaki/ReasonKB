import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import {
  getSystemSettings,
  updateSystemSettings,
} from "@/lib/repos/system-settings-store";
import { updateEnvFileValue } from "@/lib/server-env-file";

function isAbsoluteHostPath(value: string) {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

const schema = z.object({
  indexWorkerConcurrency: z.number().int().min(1).max(16).optional(),
  retrievalDocumentLimit: z.number().int().min(1).max(50).optional(),
  projectsRootHostPath: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value), {
      message: "Projects root host path must be a single line.",
    })
    .refine(isAbsoluteHostPath, {
      message: "Projects root host path must be an absolute host path.",
    })
    .optional(),
  llmApiKey: z.string().trim().optional().nullable(),
  llmBaseUrl: z
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
  llmModel: z.string().trim().min(1).optional(),
  llmRetrievalModel: z.string().trim().min(1).optional(),
});

const defaults = {
  indexWorkerConcurrency: Number.parseInt(
    process.env.INDEX_WORKER_CONCURRENCY ?? "1",
    10,
  ),
  retrievalDocumentLimit: 5,
  llmApiKey: process.env.PAGEINDEX_LLM_API_KEY ?? "",
  llmBaseUrl: process.env.PAGEINDEX_LLM_BASE_URL ?? "",
  llmModel: process.env.PAGEINDEX_LLM_MODEL ?? "openai/deepseek-v4-flash",
  llmRetrievalModel:
    process.env.PAGEINDEX_LLM_RETRIEVAL_MODEL ??
    process.env.PAGEINDEX_LLM_MODEL ??
    "openai/deepseek-v4-flash",
  projectsRootHostPath: appConfig.currentProjectsRootHostPath,
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

  if (parsed.data.projectsRootHostPath !== undefined && appConfig.envFilePath) {
    try {
      updateEnvFileValue(
        appConfig.envFilePath,
        "REASONKB_PROJECTS_ROOT",
        parsed.data.projectsRootHostPath,
      );
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unable to update Docker environment file.",
        },
        { status: 500 },
      );
    }
  }

  const settings = updateSystemSettings(appConfig.dbPath, parsed.data, defaults);

  return NextResponse.json({
    settings,
    projectsRootSwitch:
      parsed.data.projectsRootHostPath === undefined
        ? undefined
        : {
            envFilePath: appConfig.envFilePath,
            composeCommand: appConfig.composeCommand,
            pendingHostPath: settings.pendingProjectsRootHostPath,
          },
  });
}
