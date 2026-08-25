import path from "node:path";
import { z } from "zod";

const displayName = z.string().trim().min(1).max(120);
const schedule = z
  .object({
    mode: z.enum(["scheduled", "manual"]).default("scheduled"),
    intervalSeconds: z.number().int().positive().optional(),
    maxDocumentSizeBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024)
      .default(100 * 1024 * 1024),
  })
  .default({
    mode: "scheduled",
    maxDocumentSizeBytes: 100 * 1024 * 1024,
  });

const localSource = z.object({
  kind: z.literal("local"),
  displayName,
  scope: z.object({ rootPath: z.string().trim().min(1) }),
  config: z.object({}).default({}),
  credentials: z.object({}).default({}),
  schedule,
});

const smbSource = z.object({
  kind: z.literal("smb"),
  displayName,
  scope: z.object({
    host: z.string().trim().min(1).max(255),
    share: z.string().trim().min(1).max(255),
    basePath: z.string().trim().default(""),
    port: z.number().int().min(1).max(65535).default(445),
  }),
  config: z
    .object({ authProtocol: z.enum(["ntlm", "negotiate"]).default("ntlm") })
    .default({ authProtocol: "ntlm" }),
  credentials: z.object({
    username: z.string().trim().min(1).max(255),
    password: z.string().min(1).max(4096),
    domain: z.string().trim().max(255).default(""),
  }),
  schedule,
});

const seeyonSource = z.object({
  kind: z.literal("seeyon"),
  displayName,
  scope: z.object({
    endpoint: z.string().trim().url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "Seeyon endpoint must use HTTP or HTTPS."),
  }),
  config: z.object({ loginName: z.string().trim().min(1).max(255) }),
  credentials: z.object({
    username: z.string().trim().min(1).max(255),
    password: z.string().min(1).max(4096),
  }),
  schedule,
});

const seeyonMigration = z
  .object({
    scope: z.object({
      endpoint: z.string().trim().url().refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      }, "Seeyon endpoint must use HTTP or HTTPS."),
    }),
    config: z
      .object({ loginName: z.string().trim().min(1).max(255) })
      .optional(),
    credentials: z
      .object({
        username: z.string().trim().min(1).max(255).optional(),
        password: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const createCorpusSourceSchema = z.discriminatedUnion("kind", [
  localSource,
  smbSource,
  seeyonSource,
]);

export type CreateCorpusSourceInput = z.infer<typeof createCorpusSourceSchema>;
export type SeeyonSourceMigrationInput = z.infer<typeof seeyonMigration>;

const updateCommon = {
  displayName: displayName.optional(),
  schedule: z
    .object({
      mode: z.enum(["scheduled", "manual"]).optional(),
      intervalSeconds: z.number().int().positive().optional(),
      maxDocumentSizeBytes: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024 * 1024)
        .optional(),
    })
    .optional(),
};

const updateSchemas = {
  local: z
    .object({
      ...updateCommon,
      config: z.object({}).strict().optional(),
      credentials: z.object({}).strict().optional(),
    })
    .strict(),
  smb: z
    .object({
      ...updateCommon,
      config: z
        .object({ authProtocol: z.enum(["ntlm", "negotiate"]).optional() })
        .strict()
        .optional(),
      credentials: z
        .object({
          username: z.string().trim().min(1).max(255).optional(),
          password: z.string().min(1).max(4096).optional(),
          domain: z.string().trim().max(255).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  seeyon: z
    .object({
      ...updateCommon,
      config: z
        .object({ loginName: z.string().trim().min(1).max(255).optional() })
        .strict()
        .optional(),
      credentials: z
        .object({
          username: z.string().trim().min(1).max(255).optional(),
          password: z.string().min(1).max(4096).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
} as const;

export type UpdateCorpusSourceInput = {
  displayName?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  schedule?: {
    mode?: "scheduled" | "manual";
    intervalSeconds?: number;
    maxDocumentSizeBytes?: number;
  };
};

const DEFAULT_INTERVALS = { local: 30, smb: 300, seeyon: 600 } as const;
const MINIMUM_INTERVALS = { local: 5, smb: 30, seeyon: 60 } as const;

export function normalizeCorpusSourceInput(
  input: CreateCorpusSourceInput,
  localAccessRoot: string,
) {
  const interval = input.schedule.intervalSeconds ?? DEFAULT_INTERVALS[input.kind];
  if (interval < MINIMUM_INTERVALS[input.kind]) {
    throw new Error(
      `${input.kind} synchronization interval must be at least ${MINIMUM_INTERVALS[input.kind]} seconds.`,
    );
  }
  if (input.kind === "local") {
    const accessRoot = path.resolve(localAccessRoot);
    const rootPath = path.resolve(input.scope.rootPath);
    const relative = path.relative(accessRoot, rootPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Local source path must be inside the Local Source Access Root.");
    }
    return {
      ...input,
      scope: { rootPath },
      schedule: { ...input.schedule, intervalSeconds: interval },
    };
  }
  if (input.kind === "smb") {
    return {
      ...input,
      scope: {
        ...input.scope,
        host: input.scope.host.toLowerCase(),
        basePath: input.scope.basePath
          .replace(/\\/g, "/")
          .split("/")
          .filter(Boolean)
          .join("/"),
      },
      schedule: { ...input.schedule, intervalSeconds: interval },
    };
  }
  return {
    ...input,
    scope: { endpoint: input.scope.endpoint.replace(/\/+$/, "") },
    schedule: { ...input.schedule, intervalSeconds: interval },
  };
}

export function parseCorpusSourceUpdate(
  kind: "local" | "smb" | "seeyon",
  value: unknown,
) {
  const parsed = updateSchemas[kind].safeParse(value);
  if (!parsed.success) {
    return parsed;
  }
  const interval = parsed.data.schedule?.intervalSeconds;
  if (interval !== undefined && interval < MINIMUM_INTERVALS[kind]) {
    return {
      success: false as const,
      error: new z.ZodError([
        {
          code: "custom",
          path: ["schedule", "intervalSeconds"],
          message: `${kind} synchronization interval must be at least ${MINIMUM_INTERVALS[kind]} seconds.`,
        },
      ]),
    };
  }
  return { success: true as const, data: parsed.data as UpdateCorpusSourceInput };
}

export function parseSeeyonSourceMigration(value: unknown) {
  const parsed = seeyonMigration.safeParse(value);
  if (!parsed.success) return parsed;
  return {
    success: true as const,
    data: {
      ...parsed.data,
      scope: { endpoint: parsed.data.scope.endpoint.replace(/\/+$/, "") },
    },
  };
}
