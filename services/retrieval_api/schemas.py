from pydantic import BaseModel, Field


class QueryRequest(BaseModel):
    query: str = Field(min_length=1)
    projectIds: list[str] = Field(default_factory=list)
    mode: str = "answer"


class Citation(BaseModel):
    projectId: str
    projectName: str
    documentId: str
    documentName: str
    pages: str
    focusPage: int | None = None
    excerpt: str | None = None


class SelectedDocument(BaseModel):
    documentId: str
    sourceRelativePath: str | None = None


class EvidenceItem(BaseModel):
    projectId: str
    projectName: str
    documentId: str
    documentName: str
    sourceRelativePath: str | None = None
    projectRelativePath: str | None = None
    pages: str
    evidenceKind: str
    excerpt: str | None = None
    content: str
    visualAssets: list[dict] = []


class QueryResponse(BaseModel):
    answer: str
    citations: list[Citation]
    selectedDocuments: list[SelectedDocument]
    evidence: list[EvidenceItem] = []


class LlmTestRequest(BaseModel):
    apiKey: str | None = None
    baseUrl: str | None = None
    model: str | None = None


class LlmTestResponse(BaseModel):
    success: bool
    model: str
    elapsedMs: int
    output: str
    errorType: str | None = None
    message: str
    details: str = ""
