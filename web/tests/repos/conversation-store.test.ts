import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createProject } from "@/tests/helpers/source-project";
import {
  createConversation,
  replaceConversationProjects,
  getConversationById,
  getConversationDetail,
  appendConversationMessage,
} from "@/lib/repos/conversation-store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("conversation store", () => {
  it("persists project scope on a conversation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conv-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);

    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const conversation = createConversation(dbPath, "user_demo");
    replaceConversationProjects(dbPath, conversation.id, [project.id]);
    appendConversationMessage(dbPath, {
      conversationId: conversation.id,
      role: "user",
      content: "Summarize Alpha",
      citations: [],
    });

    const detail = getConversationDetail(dbPath, conversation.id);

    expect(detail!.projectIds).toEqual([project.id]);
    expect(detail!.messages).toHaveLength(1);
  });

  it("dedupes repeated project ids when replacing conversation scope", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conv-dedupe-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);

    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const conversation = createConversation(dbPath, "user_demo");
    replaceConversationProjects(dbPath, conversation.id, [project.id, project.id]);

    const detail = getConversationDetail(dbPath, conversation.id);
    expect(detail!.projectIds).toEqual([project.id]);
  });

  it("scopes conversation lookup to the owner when provided", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conv-owner-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);

    const ownConversation = createConversation(dbPath, "user_demo");
    const otherConversation = createConversation(dbPath, "user_other");

    expect(getConversationById(dbPath, ownConversation.id, "user_demo")?.id).toBe(
      ownConversation.id,
    );
    expect(getConversationById(dbPath, otherConversation.id, "user_demo")).toBeNull();
  });

  it("falls back to an empty citation list when stored citations are invalid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conv-citations-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);

    const conversation = createConversation(dbPath, "user_demo");
    appendConversationMessage(dbPath, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Answer",
      citations: [],
    });

    const db = new Database(dbPath);
    db.prepare(`UPDATE conversation_messages SET citations_json = ? WHERE conversation_id = ?`).run(
      "{invalid-json",
      conversation.id,
    );
    db.close();

    const detail = getConversationDetail(dbPath, conversation.id);

    expect(detail!.messages).toHaveLength(1);
    expect(detail!.messages[0]?.citations).toEqual([]);
  });
});
