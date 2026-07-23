"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Locale = "zh" | "en";

const localeStorageKey = "reasonkb.locale";

const messages = {
  en: {
    "app.subtitle": "Knowledge Workspace",
    "nav.close": "Close navigation",
    "nav.open": "Open navigation",
    "nav.newChat": "New Chat",
    "nav.chat": "Chat",
    "nav.projects": "Projects",
    "nav.sources": "Data sources",
    "nav.settings": "Settings",
    "nav.recentChats": "Recent Chats",
    "nav.historyEmpty": "Conversation history will appear here.",
    "language.label": "Language",
    "language.zh": "中文",
    "language.en": "English",
    "language.settingsEyebrow": "Interface",
    "language.settingsTitle": "Interface language",
    "language.settingsDescription": "Choose the Web UI display language.",

    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.saving": "Saving...",
    "common.unknown": "Unknown",
    "common.pending": "Pending",
    "common.complete": "Complete",
    "common.inProgress": "In progress",
    "common.loadingFolders": "Loading folders...",
    "common.up": "Up",

    "scope.allProjects": "All projects",
    "scope.filtered": "Filtered",
    "scope.multipleProjects": "Multiple projects",
    "scope.unknownProject": "Unknown project",

    "chat.eyebrow": "ReasonKB Chat",
    "chat.scope": "Scope",
    "chat.newChat": "New Chat",
    "chat.modelMissingTitle": "Model service is not configured",
    "chat.modelMissingDescription":
      "Missing {fields}. Chat answers and document indexing need a model endpoint.",
    "chat.configureModel": "Configure model",
    "chat.emptyTitle": "Ask across projects",
    "chat.emptyDescription":
      "Ask across every indexed project, optionally select project scopes, or switch to Evidence mode to inspect retrieved source blocks.",
    "chat.messageLabel": "Message",
    "chat.placeholderAll":
      "Search across all projects, or select project chips to narrow scope...",
    "chat.placeholderSelected": "Ask a question about the selected projects...",
    "chat.retrievalMode": "Retrieval mode",
    "chat.answerMode": "Answer",
    "chat.evidenceMode": "Evidence",
    "chat.answerModeAria": "Answer mode",
    "chat.evidenceModeAria": "Evidence mode",
    "chat.send": "Send",
    "chat.sending": "Sending...",
    "chat.sendError": "Unable to send message. Please try again.",
    "chat.progressTitle": "Retrieval progress",
    "chat.progressRetrievalStarted": "Starting retrieval...",
    "chat.progressDocumentsLoaded": "Loaded {count} ready documents.",
    "chat.progressSelectionStarted": "Selecting candidate documents...",
    "chat.progressDocumentsSelected": "Selected {count} document{plural}.",
    "chat.progressEvidenceStarted": "Loading evidence from selected documents...",
    "chat.progressDocumentEvidenceStarted": "Reading {document}.",
    "chat.progressDocumentPagesSelected": "Selected pages {pages} in {document}.",
    "chat.progressDocumentEvidenceLoaded": "Loaded evidence from {document}.",
    "chat.progressDocumentEvidenceSkipped": "Skipped {document}.",
    "chat.progressAnswerStarted": "Generating answer from evidence...",
    "chat.progressAnswerCompleted": "Answer generated.",
    "chat.progressCompleted": "Retrieval complete.",
    "chat.progressFailed": "Retrieval failed. Please try again.",
    "chat.progressSelectedDocuments": "Selected documents",
    "chat.evidenceHelp":
      "Evidence mode returns source snippets and paths for downstream processing.",
    "chat.answerAllHelp":
      "Answer mode searches every ready document unless project chips are selected.",
    "chat.answerSelectedHelp": "Answer mode synthesizes a response from retrieved evidence.",
    "chat.noProjects":
      "No projects yet. Retrieval will use all ready documents once they are indexed.",
    "chat.roleUser": "You",
    "chat.roleAssistant": "Assistant",
    "chat.evidence": "Evidence",
    "chat.pages": "pages",
    "chat.focusPage": "focus page",

    "projects.eyebrow": "Workspace",
    "projects.title": "Projects",
    "projects.description":
      "Browse active source collections and use them as retrieval scopes in chat.",
    "projects.search": "Search projects",
    "projects.noMatchesTitle": "No matching projects",
    "projects.noMatchesDescription":
      'No projects match "{query}". Try a different search.',
    "projects.emptyTitle": "No projects yet",
    "projects.emptyDescription": "Select and synchronize a collection from Data sources.",
    "projects.openAria": "Open {name}",
    "projects.folder": "Folder",
    "projects.docs": "{count} docs",
    "projects.updatedRecently": "Updated recently",
    "projects.updated": "Updated {date}",
    "projectDetail.description":
      "Review source documents and indexing status for this collection.",
    "projectDetail.searchDocuments": "Search documents",

    "documents.fileName": "File Name",
    "documents.sourcePath": "Source Path",
    "documents.pageCount": "Page Count",
    "documents.indexingStatus": "Indexing Status",
    "documents.parseMetrics": "Parse Metrics",
    "documents.sourceUpdate": "Source Update",
    "documents.actions": "Actions",
    "documents.noMatches":
      'No matching documents for "{query}" in this project.',
    "documents.empty": "No documents found in this project.",
    "documents.failedReindex": "Failed to queue document reindex.",
    "documents.reindexQueued": "Reindex queued for {name}.",
    "documents.failedTree": "Failed to load document index tree.",
    "documents.viewTreeFor": "View index tree for {name}",
    "documents.treeUnavailableFor": "Index tree unavailable for {name}",
    "documents.viewNodeCount": "View {count} PageIndex nodes",
    "documents.viewTree": "View PageIndex tree",
    "documents.treeAfterIndex": "Index tree is available after indexing completes",
    "documents.reindex": "Reindex {name}",
    "documents.pageIndexTreeFor": "PageIndex tree for {name}",
    "documents.pageIndexTree": "PageIndex Tree",
    "documents.closePageIndexTree": "Close PageIndex tree",
    "documents.loadingTree": "Loading PageIndex tree...",
    "documents.noTreeNodes": "This document index has no tree nodes.",
    "documents.depth": "Depth {depth}",
    "documents.nodeCount": "{count} node{plural}",
    "documents.leafCount": "{count} {leaf}",
    "documents.pending": "Pending",
    "documents.tokens": "{count} tokens",
    "documents.tokenK": "{count}K tokens",
    "documents.calls": "{count} {unit}",
    "documents.callSingular": "call",
    "documents.callPlural": "calls",
    "documents.statusUnknown": "Unknown",
    "documents.excluded": "Excluded",
    "documents.excludedAction": "Excluded documents cannot be opened or reindexed",

    "apiKeys.eyebrow": "Agent access",
    "apiKeys.title": "API keys",
    "apiKeys.description":
      "Manage scoped credentials used by agents, CLI clients, and MCP servers.",
    "apiKeys.name": "Name",
    "apiKeys.namePlaceholder": "Production agent",
    "apiKeys.scopes": "Scopes",
    "apiKeys.projects": "Project access",
    "apiKeys.allProjects": "All projects",
    "apiKeys.selectedProjects": "Selected projects",
    "apiKeys.noProjects": "No active projects are available.",
    "apiKeys.create": "Create API key",
    "apiKeys.creating": "Creating...",
    "apiKeys.created": "Created",
    "apiKeys.lastUsed": "Last used",
    "apiKeys.status": "Status",
    "apiKeys.actions": "Actions",
    "apiKeys.never": "Never",
    "apiKeys.active": "Active",
    "apiKeys.revoked": "Revoked",
    "apiKeys.revoke": "Revoke API key",
    "apiKeys.revokeConfirm": "Revoke API key {name}?",
    "apiKeys.projectCount": "{count} projects",
    "apiKeys.empty": "No API keys have been created.",
    "apiKeys.secretTitle": "API key created",
    "apiKeys.secretOnce": "This key is shown once. Store it before closing.",
    "apiKeys.copy": "Copy",
    "apiKeys.copied": "Copied",
    "apiKeys.close": "Close",
    "apiKeys.loadError": "Unable to load API keys.",
    "apiKeys.createError": "Unable to create the API key.",
    "apiKeys.revokeError": "Unable to revoke the API key.",

    "settings.eyebrow": "Operations",
    "settings.title": "System settings",
    "settings.description":
      "Runtime controls stored in the application database and picked up by background services without a container restart.",
    "settings.modelEyebrow": "Model service",
    "settings.modelReady": "Model service is ready",
    "settings.modelMissing": "Model service is not configured",
    "settings.modelDescription":
      "Configure the OpenAI-compatible endpoint used by document indexing and retrieval answers.",
    "settings.apiKeySaved": "API key is saved",
    "settings.apiKeyMissing": "API key is not saved",
    "settings.baseUrlMissing": "Base URL is missing",
    "settings.baseUrlSet": "Base URL is set",
    "settings.apiKey": "API key",
    "settings.keepApiKey": "Leave blank to keep saved key",
    "settings.pasteApiKey": "Paste a new API key",
    "settings.baseUrl": "Base URL",
    "settings.invalidBaseUrl": "Base URL must start with http:// or https://.",
    "settings.interfaceFormat": "Interface format",
    "settings.retrievalInterfaceFormat": "Retrieval interface format",
    "settings.interfaceOpenAiCompatible": "OpenAI-compatible Chat Completions",
    "settings.interfaceAnthropicMessages": "Anthropic Messages",
    "settings.model": "Model",
    "settings.retrievalModel": "Retrieval model",
    "settings.useSeparateRetrievalModel": "Use a separate retrieval model",
    "settings.useSeparateRetrievalModelDescription":
      "Keep this off unless document selection needs a different model from answer generation.",
    "settings.modelTest": "Model test",
    "settings.modelTestDescription":
      "Send a minimal request with the current form values. Leave API key blank to use the saved key.",
    "settings.testModel": "Test",
    "settings.modelTesting": "Testing...",
    "settings.modelTestError": "Unable to run model test.",
    "settings.projectCorpus": "Project corpus",
    "settings.projectsRoot": "Projects root",
    "settings.projectsRootDescription":
      "Controls the host directory Docker mounts as the project corpus. The running containers must be recreated before the new host path is available at /data/projects.",
    "settings.smbCorpusSource": "SMB corpus source",
    "settings.smbCorpusDescription":
      "ReasonKB is reading project metadata from a Windows/SMB share. Documents are downloaded only when indexing needs file contents.",
    "settings.corpusSourceType": "Corpus source:",
    "settings.smbTarget": "SMB target",
    "settings.smbLocalSwitchDisabled":
      "Local Projects root switching is disabled while the corpus source is SMB. Change the SMB connection in the Docker environment and recreate the containers.",
    "settings.notConfigured": "Not configured",
    "settings.currentMountedHostPath": "Current mounted host path:",
    "settings.notReportedByDocker": "Not reported by Docker",
    "settings.dockerEnvFile": "Docker env file:",
    "settings.selectedProjectsRoot": "Selected projects root",
    "settings.noHostFolderSelected": "No host folder selected",
    "settings.folderPickerRoot": "Folder picker root:",
    "settings.chooseAbsoluteHostFolder":
      "Choose an absolute host folder for the project corpus.",
    "settings.pickerUnavailable":
      "Folder picker is unavailable because REASONKB_HOST_BROWSE_ROOT is not mounted.",
    "settings.chooseFolder": "Choose folder",
    "settings.switchProjectsRoot": "Switch projects root",
    "settings.switchComplete": "Projects root switch is complete.",
    "settings.switchWaiting":
      "Waiting for Docker recreate to mount the new project corpus.",
    "settings.switchProgressAria": "Projects root switch progress",
    "settings.switchStep1": "1. Switch target saved: {path}",
    "settings.switchStep2Env":
      "Docker env file updated. Recreate containers on the host.",
    "settings.switchStep2Manual":
      "Update REASONKB_PROJECTS_ROOT in the Docker env file, then recreate containers on the host.",
    "settings.switchStep3": "3. ReasonKB reports the new mounted root after restart: {status}",
    "settings.done": "done",
    "settings.waiting": "waiting",
    "settings.requestedAt": "Requested at: {date}",
    "settings.indexing": "Indexing",
    "settings.workerConcurrency": "Worker concurrency",
    "settings.workerDescription":
      "Controls how many document index jobs the single index-worker container may run at the same time. Lower values stop new dispatches; active jobs finish naturally.",
    "settings.concurrentJobs": "Concurrent jobs",
    "settings.allowedRange": "Allowed range: {range}",
    "settings.retrieval": "Retrieval",
    "settings.candidateLimit": "Candidate document limit",
    "settings.retrievalDescription":
      "Controls how many ready documents may be selected for a single retrieval query before evidence is loaded and the final answer is generated.",
    "settings.retrievalDocuments": "Retrieval documents",
    "settings.saveSettings": "Save settings",
    "settings.saved": "Settings saved.",
    "settings.saveError": "Unable to save system settings. Please try again.",
    "settings.rootPrepareError":
      "Unable to prepare the projects root switch. Please try again.",
    "settings.hostDirectoriesError":
      "Unable to load host folders. Please check the Docker browse root mount.",
    "settings.rootPrepared": "Projects root switch prepared.",
    "settings.hostFolderPicker": "Host folder picker",
    "settings.chooseRootFolder": "Choose projects root folder",
    "settings.currentSelection": "Current selection",
    "settings.emptyFolder": "This folder has no child folders.",
    "settings.useSelectedFolder": "Use selected folder",
    "settings.dockerRestartRequired": "Docker restart required",
    "settings.switchDialogDescription":
      "Docker bind mount changes require recreating the containers. ReasonKB will save the new host path now{envNote}, then wait until Docker restarts with that path mounted.",
    "settings.envNote": " and update the Docker env file",
    "settings.targetHostPath": "Target host path",
    "settings.progressWillShow":
      "Progress will show the saved target, the Docker recreate step, and completion after the restarted app reports the new mounted root.",
    "settings.runOnHost": "Run this on the host after confirming:",
    "settings.preparing": "Preparing...",
    "settings.confirmSwitch": "Confirm switch",
    "settings.securityEyebrow": "Security",
    "settings.changeAdminPassword": "Change administrator password",
    "settings.passwordDescription":
      "Changing the password signs out every administrator session, including this one.",
    "settings.currentPassword": "Current password",
    "settings.newPassword": "New password",
    "settings.confirmPassword": "Confirm new password",
    "settings.passwordRequirements": "Use 12 to 1024 characters.",
    "settings.passwordMismatch": "The new passwords do not match.",
    "settings.passwordMustDiffer": "The new password must be different.",
    "settings.passwordCurrentIncorrect": "The current password is incorrect.",
    "settings.passwordChangeError": "Unable to change the administrator password.",
    "settings.changePassword": "Change password",
    "settings.passwordChanging": "Changing...",
  },
  zh: {
    "app.subtitle": "知识工作区",
    "nav.close": "关闭导航",
    "nav.open": "打开导航",
    "nav.newChat": "新建对话",
    "nav.chat": "对话",
    "nav.projects": "项目",
    "nav.sources": "数据源",
    "nav.settings": "设置",
    "nav.recentChats": "最近对话",
    "nav.historyEmpty": "对话历史会显示在这里。",
    "language.label": "语言",
    "language.zh": "中文",
    "language.en": "English",
    "language.settingsEyebrow": "界面",
    "language.settingsTitle": "界面语言",
    "language.settingsDescription": "选择 Web UI 显示语言。",

    "common.cancel": "取消",
    "common.save": "保存",
    "common.saving": "保存中...",
    "common.unknown": "未知",
    "common.pending": "待处理",
    "common.complete": "已完成",
    "common.inProgress": "进行中",
    "common.loadingFolders": "正在加载文件夹...",
    "common.up": "上一级",

    "scope.allProjects": "全部项目",
    "scope.filtered": "已筛选",
    "scope.multipleProjects": "多个项目",
    "scope.unknownProject": "未知项目",

    "chat.eyebrow": "ReasonKB 对话",
    "chat.scope": "范围",
    "chat.newChat": "新对话",
    "chat.modelMissingTitle": "模型服务未配置",
    "chat.modelMissingDescription": "缺少 {fields}。对话回答和文档索引都需要模型端点。",
    "chat.configureModel": "配置模型",
    "chat.emptyTitle": "跨项目提问",
    "chat.emptyDescription":
      "可以在所有已索引项目中提问，也可以选择项目范围，或切到证据模式查看检索到的来源片段。",
    "chat.messageLabel": "消息",
    "chat.placeholderAll": "搜索全部项目，或选择项目标签来缩小范围...",
    "chat.placeholderSelected": "针对已选择的项目提问...",
    "chat.retrievalMode": "检索模式",
    "chat.answerMode": "回答",
    "chat.evidenceMode": "证据",
    "chat.answerModeAria": "回答模式",
    "chat.evidenceModeAria": "证据模式",
    "chat.send": "发送",
    "chat.sending": "发送中...",
    "chat.sendError": "消息发送失败，请重试。",
    "chat.progressTitle": "检索过程",
    "chat.progressRetrievalStarted": "开始检索...",
    "chat.progressDocumentsLoaded": "已加载 {count} 个就绪文档。",
    "chat.progressSelectionStarted": "正在选择候选文档...",
    "chat.progressDocumentsSelected": "已选择 {count} 个文档。",
    "chat.progressEvidenceStarted": "正在读取选中文档的证据...",
    "chat.progressDocumentEvidenceStarted": "正在读取 {document}。",
    "chat.progressDocumentPagesSelected": "已在 {document} 中选择页码 {pages}。",
    "chat.progressDocumentEvidenceLoaded": "已从 {document} 读取证据。",
    "chat.progressDocumentEvidenceSkipped": "已跳过 {document}。",
    "chat.progressAnswerStarted": "正在基于证据生成回答...",
    "chat.progressAnswerCompleted": "回答已生成。",
    "chat.progressCompleted": "检索完成。",
    "chat.progressFailed": "检索失败，请稍后重试。",
    "chat.progressSelectedDocuments": "选中文档",
    "chat.evidenceHelp": "证据模式会返回来源片段和路径，便于后续处理。",
    "chat.answerAllHelp": "回答模式会搜索所有已就绪文档，除非选择了项目标签。",
    "chat.answerSelectedHelp": "回答模式会基于检索到的证据生成回复。",
    "chat.noProjects": "还没有项目。文档索引完成后，检索会使用所有已就绪文档。",
    "chat.roleUser": "你",
    "chat.roleAssistant": "助手",
    "chat.evidence": "证据",
    "chat.pages": "页",
    "chat.focusPage": "焦点页",

    "projects.eyebrow": "工作区",
    "projects.title": "项目",
    "projects.description": "浏览已启用的数据源目录，并在对话中作为检索范围使用。",
    "projects.search": "搜索项目",
    "projects.noMatchesTitle": "没有匹配的项目",
    "projects.noMatchesDescription": "没有项目匹配“{query}”。请尝试其他搜索。",
    "projects.emptyTitle": "还没有项目",
    "projects.emptyDescription": "请在数据源中选择并同步至少一个目录。",
    "projects.openAria": "打开 {name}",
    "projects.folder": "文件夹",
    "projects.docs": "{count} 个文档",
    "projects.updatedRecently": "最近更新",
    "projects.updated": "更新于 {date}",
    "projectDetail.description": "查看此目录的源文档和索引状态。",
    "projectDetail.searchDocuments": "搜索文档",

    "documents.fileName": "文件名",
    "documents.sourcePath": "来源路径",
    "documents.pageCount": "页数",
    "documents.indexingStatus": "索引状态",
    "documents.parseMetrics": "解析指标",
    "documents.sourceUpdate": "源更新时间",
    "documents.actions": "操作",
    "documents.noMatches": "此项目中没有匹配“{query}”的文档。",
    "documents.empty": "此项目中没有文档。",
    "documents.failedReindex": "无法提交文档重新索引。",
    "documents.reindexQueued": "已提交 {name} 重新索引。",
    "documents.failedTree": "无法加载文档索引树。",
    "documents.viewTreeFor": "查看 {name} 的索引树",
    "documents.treeUnavailableFor": "{name} 的索引树不可用",
    "documents.viewNodeCount": "查看 {count} 个 PageIndex 节点",
    "documents.viewTree": "查看 PageIndex 树",
    "documents.treeAfterIndex": "索引完成后可查看索引树",
    "documents.reindex": "重新索引 {name}",
    "documents.pageIndexTreeFor": "{name} 的 PageIndex 树",
    "documents.pageIndexTree": "PageIndex 树",
    "documents.closePageIndexTree": "关闭 PageIndex 树",
    "documents.loadingTree": "正在加载 PageIndex 树...",
    "documents.noTreeNodes": "该文档索引没有树节点。",
    "documents.depth": "深度 {depth}",
    "documents.nodeCount": "{count} 个节点",
    "documents.leafCount": "{count} 个叶子节点",
    "documents.pending": "待处理",
    "documents.tokens": "{count} tokens",
    "documents.tokenK": "{count}K tokens",
    "documents.calls": "{count} 次调用",
    "documents.callSingular": "调用",
    "documents.callPlural": "调用",
    "documents.statusUnknown": "未知",
    "documents.excluded": "已排除",
    "documents.excludedAction": "已排除的文档不能查看索引或重新索引",

    "apiKeys.eyebrow": "Agent 访问",
    "apiKeys.title": "API 密钥",
    "apiKeys.description": "管理 Agent、CLI 和 MCP 使用的分范围访问凭证。",
    "apiKeys.name": "名称",
    "apiKeys.namePlaceholder": "生产环境 Agent",
    "apiKeys.scopes": "权限范围",
    "apiKeys.projects": "项目访问范围",
    "apiKeys.allProjects": "全部项目",
    "apiKeys.selectedProjects": "指定项目",
    "apiKeys.noProjects": "当前没有可用项目。",
    "apiKeys.create": "创建 API 密钥",
    "apiKeys.creating": "创建中...",
    "apiKeys.created": "创建时间",
    "apiKeys.lastUsed": "最后使用",
    "apiKeys.status": "状态",
    "apiKeys.actions": "操作",
    "apiKeys.never": "从未使用",
    "apiKeys.active": "有效",
    "apiKeys.revoked": "已撤销",
    "apiKeys.revoke": "撤销 API 密钥",
    "apiKeys.revokeConfirm": "确认撤销 API 密钥 {name}？",
    "apiKeys.projectCount": "{count} 个项目",
    "apiKeys.empty": "尚未创建 API 密钥。",
    "apiKeys.secretTitle": "API 密钥已创建",
    "apiKeys.secretOnce": "完整密钥仅显示一次，请在关闭前妥善保存。",
    "apiKeys.copy": "复制",
    "apiKeys.copied": "已复制",
    "apiKeys.close": "关闭",
    "apiKeys.loadError": "无法加载 API 密钥。",
    "apiKeys.createError": "无法创建 API 密钥。",
    "apiKeys.revokeError": "无法撤销 API 密钥。",

    "settings.eyebrow": "运维",
    "settings.title": "系统设置",
    "settings.description": "运行时控制项会保存在应用数据库中，后台服务可读取，无需重启容器。",
    "settings.modelEyebrow": "模型服务",
    "settings.modelReady": "模型服务已就绪",
    "settings.modelMissing": "模型服务未配置",
    "settings.modelDescription": "配置文档索引和检索回答使用的 OpenAI 兼容端点。",
    "settings.apiKeySaved": "API Key 已保存",
    "settings.apiKeyMissing": "API Key 未保存",
    "settings.baseUrlMissing": "Base URL 缺失",
    "settings.baseUrlSet": "Base URL 已设置",
    "settings.apiKey": "API Key",
    "settings.keepApiKey": "留空以保留已保存的 Key",
    "settings.pasteApiKey": "粘贴新的 API Key",
    "settings.baseUrl": "Base URL",
    "settings.invalidBaseUrl": "Base URL 必须以 http:// 或 https:// 开头。",
    "settings.interfaceFormat": "接口格式",
    "settings.retrievalInterfaceFormat": "检索接口格式",
    "settings.interfaceOpenAiCompatible": "OpenAI 兼容 Chat Completions",
    "settings.interfaceAnthropicMessages": "Anthropic Messages",
    "settings.model": "模型",
    "settings.retrievalModel": "检索模型",
    "settings.useSeparateRetrievalModel": "检索使用单独模型",
    "settings.useSeparateRetrievalModelDescription":
      "除非文档选择需要与回答生成使用不同模型，否则保持关闭。",
    "settings.modelTest": "模型测试",
    "settings.modelTestDescription":
      "使用当前表单值发送一次最小请求。API Key 留空时会使用已保存的 Key。",
    "settings.testModel": "测试",
    "settings.modelTesting": "测试中...",
    "settings.modelTestError": "无法执行模型测试。",
    "settings.projectCorpus": "项目语料库",
    "settings.projectsRoot": "Projects 根目录",
    "settings.projectsRootDescription":
      "控制 Docker 挂载为项目语料库的宿主机目录。运行中的容器必须重新创建，新宿主机路径才会在 /data/projects 可用。",
    "settings.smbCorpusSource": "SMB 语料来源",
    "settings.smbCorpusDescription":
      "ReasonKB 正在从 Windows/SMB 共享读取项目元数据。只有索引需要文件内容时，才会下载文档。",
    "settings.corpusSourceType": "语料来源：",
    "settings.smbTarget": "SMB 目标",
    "settings.smbLocalSwitchDisabled":
      "当前语料来源为 SMB，本地 Projects 根目录切换不适用。如需修改 SMB 连接，请更新 Docker 环境配置并重新创建容器。",
    "settings.notConfigured": "未配置",
    "settings.currentMountedHostPath": "当前挂载的宿主机路径：",
    "settings.notReportedByDocker": "Docker 未上报",
    "settings.dockerEnvFile": "Docker env 文件：",
    "settings.selectedProjectsRoot": "已选择的 Projects 根目录",
    "settings.noHostFolderSelected": "未选择宿主机文件夹",
    "settings.folderPickerRoot": "文件夹选择根目录：",
    "settings.chooseAbsoluteHostFolder": "请选择一个绝对宿主机文件夹作为项目语料库。",
    "settings.pickerUnavailable":
      "文件夹选择不可用，因为没有挂载 REASONKB_HOST_BROWSE_ROOT。",
    "settings.chooseFolder": "选择文件夹",
    "settings.switchProjectsRoot": "切换 Projects 根目录",
    "settings.switchComplete": "Projects 根目录切换已完成。",
    "settings.switchWaiting": "等待 Docker 重新创建容器并挂载新的项目语料库。",
    "settings.switchProgressAria": "Projects 根目录切换进度",
    "settings.switchStep1": "1. 切换目标已保存：{path}",
    "settings.switchStep2Env": "Docker env 文件已更新。请在宿主机重新创建容器。",
    "settings.switchStep2Manual":
      "请在 Docker env 文件中更新 REASONKB_PROJECTS_ROOT，然后在宿主机重新创建容器。",
    "settings.switchStep3": "3. ReasonKB 重启后上报新的挂载根目录：{status}",
    "settings.done": "完成",
    "settings.waiting": "等待中",
    "settings.requestedAt": "请求时间：{date}",
    "settings.indexing": "索引",
    "settings.workerConcurrency": "Worker 并发数",
    "settings.workerDescription":
      "控制单个 index-worker 容器可同时运行多少个文档索引任务。较低的值会停止新的派发，正在运行的任务会自然完成。",
    "settings.concurrentJobs": "并发任务数",
    "settings.allowedRange": "允许范围：{range}",
    "settings.retrieval": "检索",
    "settings.candidateLimit": "候选文档上限",
    "settings.retrievalDescription":
      "控制单次检索查询在加载证据并生成最终回答前，最多可选择多少个已就绪文档。",
    "settings.retrievalDocuments": "检索文档数",
    "settings.saveSettings": "保存设置",
    "settings.saved": "设置已保存。",
    "settings.saveError": "无法保存系统设置，请重试。",
    "settings.rootPrepareError": "无法准备 Projects 根目录切换，请重试。",
    "settings.hostDirectoriesError": "无法加载宿主机文件夹，请检查 Docker 浏览根目录挂载。",
    "settings.rootPrepared": "Projects 根目录切换已准备好。",
    "settings.hostFolderPicker": "宿主机文件夹选择",
    "settings.chooseRootFolder": "选择 Projects 根目录文件夹",
    "settings.currentSelection": "当前选择",
    "settings.emptyFolder": "该文件夹没有子文件夹。",
    "settings.useSelectedFolder": "使用已选择的文件夹",
    "settings.dockerRestartRequired": "需要重启 Docker 容器",
    "settings.switchDialogDescription":
      "Docker 绑定挂载变更需要重新创建容器。ReasonKB 会先保存新的宿主机路径{envNote}，然后等待 Docker 使用该路径重新挂载后完成切换。",
    "settings.envNote": "并更新 Docker env 文件",
    "settings.targetHostPath": "目标宿主机路径",
    "settings.progressWillShow":
      "进度会显示目标已保存、Docker 重新创建步骤，以及重启后的应用上报新挂载根目录后的完成状态。",
    "settings.runOnHost": "确认后请在宿主机运行：",
    "settings.preparing": "准备中...",
    "settings.confirmSwitch": "确认切换",
    "settings.securityEyebrow": "安全",
    "settings.changeAdminPassword": "修改管理员密码",
    "settings.passwordDescription":
      "密码修改后，所有管理员会话（包括当前会话）都会立即退出。",
    "settings.currentPassword": "当前密码",
    "settings.newPassword": "新密码",
    "settings.confirmPassword": "确认新密码",
    "settings.passwordRequirements": "密码长度须为 12 至 1024 个字符。",
    "settings.passwordMismatch": "两次输入的新密码不一致。",
    "settings.passwordMustDiffer": "新密码不能与当前密码相同。",
    "settings.passwordCurrentIncorrect": "当前密码不正确。",
    "settings.passwordChangeError": "无法修改管理员密码，请重试。",
    "settings.changePassword": "修改密码",
    "settings.passwordChanging": "修改中...",
  },
} as const;

export type TranslationKey = keyof typeof messages.en;

type TranslationValues = Record<string, string | number>;

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, values?: TranslationValues) => string;
};

function interpolate(template: string, values?: TranslationValues) {
  if (!values) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

function translate(locale: Locale, key: TranslationKey, values?: TranslationValues) {
  return interpolate(messages[locale][key] ?? messages.en[key], values);
}

function readStoredLocale(): Locale | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const storedLocale = window.localStorage.getItem(localeStorageKey);
    return storedLocale === "en" || storedLocale === "zh" ? storedLocale : null;
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: Locale) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(localeStorageKey, locale);
  } catch {
    // Some embedded or restricted browser contexts block storage; language switching still works in memory.
  }
}

const fallbackContext: I18nContextValue = {
  locale: "en",
  setLocale: () => undefined,
  t: (key, values) => translate("en", key, values),
};

const I18nContext = createContext<I18nContextValue>(fallbackContext);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("zh");

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: (nextLocale) => {
        setLocaleState(nextLocale);
        writeStoredLocale(nextLocale);
      },
      t: (key, values) => translate(locale, key, values),
    }),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  useEffect(() => {
    const storedLocale = readStoredLocale();
    if (storedLocale) {
      setLocaleState(storedLocale);
    }
  }, []);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function LocalizedText({
  id,
  values,
}: {
  id: TranslationKey;
  values?: TranslationValues;
}) {
  const { t } = useI18n();
  return <>{t(id, values)}</>;
}

export function LocalizedSearchInput({
  id,
  name,
  defaultValue,
  labelKey,
  placeholderKey,
  className,
}: {
  id: string;
  name: string;
  defaultValue?: string;
  labelKey: TranslationKey;
  placeholderKey: TranslationKey;
  className: string;
}) {
  const { t } = useI18n();
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {t(labelKey)}
      </label>
      <input
        id={id}
        name={name}
        type="search"
        defaultValue={defaultValue ?? ""}
        placeholder={t(placeholderKey)}
        className={className}
      />
    </>
  );
}

export function LocalizedConversationTitle({ title }: { title: string }) {
  const { t } = useI18n();
  return <>{title === "New Chat" ? t("chat.newChat") : title}</>;
}

export function LocalizedScopeLabel({ value }: { value: string }) {
  const { t } = useI18n();
  if (value === "All projects") return <>{t("scope.allProjects")}</>;
  if (value === "Multiple projects") return <>{t("scope.multipleProjects")}</>;
  if (value === "Unknown project") return <>{t("scope.unknownProject")}</>;
  return <>{value}</>;
}

export function formatMissingFields(fields: string[], locale: Locale) {
  const labels = fields.map((field) => {
    if (field === "API key") return locale === "zh" ? "API Key" : "API key";
    if (field === "Base URL") return "Base URL";
    return field;
  });
  return labels.join(locale === "zh" ? "、" : " and ");
}

export function LocalizedModelMissingDescription({ fields }: { fields: string[] }) {
  const { locale, t } = useI18n();
  return (
    <>
      {t("chat.modelMissingDescription", {
        fields: formatMissingFields(fields, locale),
      })}
    </>
  );
}

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div>
      <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-muted)]">
        {t("language.label")}
      </p>
      <div className="grid grid-cols-2 rounded-lg bg-[var(--pi-bg)] p-1 text-xs font-medium text-[var(--pi-muted)]">
        {(["zh", "en"] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={locale === item}
            onClick={() => setLocale(item)}
            className={`rounded-md px-3 py-2 transition ${
              locale === item
                ? "bg-white text-[var(--pi-brand)] shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
                : "hover:text-[var(--pi-ink)]"
            }`}
          >
            {item === "zh" ? t("language.zh") : t("language.en")}
          </button>
        ))}
      </div>
    </div>
  );
}
