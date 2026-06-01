import React from "react";
import Link from "next/link";
import { LocalizedConversationTitle, LocalizedScopeLabel, useI18n } from "@/lib/i18n";

export function ChatHistoryList({
  conversations,
}: {
  conversations: Array<{ id: string; title: string; scopeLabel: string }>;
}) {
  const { t } = useI18n();

  if (conversations.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--pi-border)] bg-[var(--pi-bg)] px-3 py-4 text-xs text-[var(--pi-muted)]">
        {t("nav.historyEmpty")}
      </div>
    );
  }

  return (
    <>
      {conversations.map((conversation) => (
        <Link
          key={conversation.id}
          href={`/chat?conversationId=${conversation.id}`}
          className="block rounded-md px-3 py-2.5 text-sm transition hover:bg-[var(--pi-bg)]"
        >
          <p className="truncate font-medium text-[var(--pi-ink)]">
            <LocalizedConversationTitle title={conversation.title} />
          </p>
          <p className="mt-0.5 truncate text-xs text-[var(--pi-muted)]">
            <LocalizedScopeLabel value={conversation.scopeLabel} />
          </p>
        </Link>
      ))}
    </>
  );
}
