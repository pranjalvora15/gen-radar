import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


Category = Literal[
    "models",
    "research",
    "rag",
    "agents",
    "langchain-langgraph",
    "multimodal",
    "safety",
    "other",
]

CandidateContentType = Literal["research", "experiment", "tutorial"]


class ArticleRequest(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    source_name: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=2000)
    content: str = Field(min_length=1)


class KeywordRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=500)
    content: str = Field(min_length=1)
    article_explanation: dict


class CandidateInput(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=500)
    source_name: str = Field(alias="sourceName", min_length=1, max_length=200)
    source_type: CandidateContentType = Field(alias="sourceType")
    excerpt: str = Field(min_length=1, max_length=1500)
    published_at: str | None = Field(alias="publishedAt", default=None)
    citation_count: int = Field(alias="citationCount", default=0, ge=0)
    has_open_access_pdf: bool = Field(alias="hasOpenAccessPdf", default=False)


class CandidateRankingRequest(BaseModel):
    candidates: list[CandidateInput] = Field(min_length=1, max_length=40)


class CandidateAssessment(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(min_length=1, max_length=100)
    decision: Literal["accept", "reject"]
    content_type: CandidateContentType = Field(alias="contentType")
    learning_value: int = Field(alias="learningValue", ge=0, le=5)
    technical_depth: int = Field(alias="technicalDepth", ge=0, le=5)
    novelty: int = Field(ge=0, le=5)
    evidence: int = Field(ge=0, le=5)
    marketing_penalty: int = Field(alias="marketingPenalty", ge=0, le=5)
    reason: str = Field(
        default="Assessment generated from the candidate's technical evidence.",
        min_length=1,
        max_length=400,
    )


class CandidateRankingResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    assessments: list[CandidateAssessment] = Field(min_length=1, max_length=40)

    @field_validator("assessments")
    @classmethod
    def validate_unique_ids(
        cls, values: list[CandidateAssessment]
    ) -> list[CandidateAssessment]:
        ids = [value.id for value in values]
        if len(ids) != len(set(ids)):
            raise ValueError("candidate assessment ids must be unique")
        return values


class FeedSummaryInput(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=500)
    source_name: str = Field(alias="sourceName", min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=8_000)


class FeedSummaryRequest(BaseModel):
    articles: list[FeedSummaryInput] = Field(min_length=1, max_length=10)


class FeedSummary(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    summary: str = Field(min_length=200, max_length=2_500)

    @field_validator("summary")
    @classmethod
    def validate_sentence_count(cls, value: str) -> str:
        sentences = re.findall(r"[^.!?]+[.!?](?:\s+|$)", value.strip())
        if len(sentences) not in (7, 8):
            raise ValueError("feed summary must contain exactly 7 or 8 sentences")
        return value


class FeedSummaryResponse(BaseModel):
    summaries: list[FeedSummary] = Field(min_length=1, max_length=10)

    @field_validator("summaries")
    @classmethod
    def validate_unique_summary_ids(
        cls, values: list[FeedSummary]
    ) -> list[FeedSummary]:
        ids = [value.id for value in values]
        if len(ids) != len(set(ids)):
            raise ValueError("feed summary ids must be unique")
        return values


class ArticleExplanation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    category: Category
    summary: str = Field(min_length=1, max_length=1000)
    simple_explanation: str = Field(
        alias="simpleExplanation", min_length=1, max_length=2500
    )
    problem_solved: str = Field(alias="problemSolved", min_length=1, max_length=1500)
    trade_offs: list[str] = Field(alias="tradeOffs", max_length=3)
    key_points: list[str] = Field(alias="keyPoints", min_length=1, max_length=3)
    limitations: list[str] = Field(max_length=3)
    keywords: list[str] = Field(min_length=5, max_length=8)

    @field_validator("trade_offs", "key_points", "limitations", "keywords")
    @classmethod
    def validate_non_empty_items(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not value for value in cleaned):
            raise ValueError("array items must be non-empty")
        return cleaned

    @field_validator("keywords")
    @classmethod
    def validate_unique_keywords(cls, values: list[str]) -> list[str]:
        keys = [" ".join(value.lower().split()) for value in values]
        if len(keys) != len(set(keys)):
            raise ValueError("keywords must be unique")
        return values


class KeywordExplanation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    keyword: str = Field(min_length=1, max_length=100)
    simple_definition: str = Field(
        alias="simpleDefinition", min_length=1, max_length=1000
    )
    relation_to_article: str = Field(
        alias="relationToArticle", min_length=1, max_length=1500
    )
    example: str = Field(min_length=1, max_length=1500)
    related_concepts: list[str] = Field(
        alias="relatedConcepts", default_factory=list, max_length=4
    )
    prerequisites: list[str] = Field(default_factory=list, max_length=3)

    @field_validator("related_concepts", "prerequisites")
    @classmethod
    def validate_bounded_items(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not value for value in cleaned):
            raise ValueError("array items must be non-empty")
        return cleaned


class EmbedDocumentsRequest(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    content: str = Field(min_length=1)


class EmbeddedChunk(BaseModel):
    index: int = Field(ge=0)
    content: str = Field(min_length=1)
    embedding: list[float] = Field(min_length=1)


class EmbedDocumentsResponse(BaseModel):
    model: str
    dimensions: int = Field(gt=0)
    chunks: list[EmbeddedChunk] = Field(min_length=1)


class EmbedQueryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2_000)


class EmbedQueryResponse(BaseModel):
    model: str
    dimensions: int = Field(gt=0)
    embedding: list[float] = Field(min_length=1)


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8_000)


class EvidenceItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=500)
    url: str = Field(min_length=1, max_length=2_000)
    excerpt: str = Field(min_length=1)
    source_type: Literal["article", "image", "video", "web"] = Field(
        alias="sourceType"
    )
    timestamp: str | None = None


class ScopeQuestionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question: str = Field(min_length=1, max_length=2_000)
    article_title: str = Field(alias="articleTitle", min_length=1, max_length=500)
    article_context: str = Field(
        alias="articleContext", default="", max_length=4_000
    )
    conversation_summary: str = Field(
        alias="conversationSummary", default="", max_length=8_000
    )
    recent_messages: list[ConversationMessage] = Field(
        alias="recentMessages", default_factory=list, max_length=8
    )
    has_selected_image: bool = Field(alias="hasSelectedImage", default=False)
    selected_media_id: int | None = Field(
        alias="selectedMediaId", default=None, gt=0
    )
    selected_media_type: Literal["image"] | None = Field(
        alias="selectedMediaType", default=None
    )
    media_analysis_completed: bool = Field(
        alias="mediaAnalysisCompleted", default=False
    )
    selected_media_analysis: str = Field(
        alias="selectedMediaAnalysis", default="", max_length=6_000
    )


class ScopeDecision(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    allowed: bool
    domain: str = Field(min_length=1, max_length=100)
    relation: Literal[
        "ai", "article-prerequisite", "conversation-follow-up", "unrelated", "unclear"
    ]
    confidence: Literal["high", "medium", "low"]
    action: Literal["continue", "close", "rephrase", "inspect_media"]
    reason_code: str = Field(alias="reasonCode", min_length=1, max_length=100)
    intent: Literal["document", "media", "research", "concept", "unclear"]


class MediaInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: int = Field(gt=0)
    media_type: Literal["image", "video"] = Field(alias="mediaType")
    url: str = Field(min_length=1, max_length=2_000)


class AnalyzeMediaRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    article_title: str = Field(alias="articleTitle", min_length=1, max_length=500)
    article_context: str = Field(
        alias="articleContext", default="", max_length=8_000
    )
    question: str = Field(default="", max_length=2_000)
    items: list[MediaInput] = Field(min_length=1, max_length=4)


class MediaTimestamp(BaseModel):
    timestamp: str = Field(min_length=1, max_length=20)
    description: str = Field(min_length=1, max_length=500)


class MediaAnalysis(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: int = Field(gt=0)
    media_type: Literal["image", "video"] = Field(alias="mediaType")
    relevant: bool
    description: str = Field(default="", max_length=2_000)
    relation_to_article: str = Field(
        alias="relationToArticle", default="", max_length=1_500
    )
    key_details: list[str] = Field(
        alias="keyDetails", default_factory=list, max_length=6
    )
    timestamps: list[MediaTimestamp] = Field(default_factory=list, max_length=8)


class MediaAnalysisResponse(BaseModel):
    analyses: list[MediaAnalysis] = Field(min_length=1, max_length=4)


class SuggestedQuestionsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    article_title: str = Field(alias="articleTitle", min_length=1, max_length=500)
    article_context: str = Field(
        alias="articleContext", min_length=1, max_length=10_000
    )
    media_context: str = Field(alias="mediaContext", default="", max_length=4_000)


class SuggestedQuestions(BaseModel):
    questions: list[str] = Field(min_length=3, max_length=3)

    @field_validator("questions")
    @classmethod
    def validate_questions(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(len(value) < 5 or len(value) > 200 for value in cleaned):
            raise ValueError("questions must contain 5 to 200 characters")
        if len({value.lower() for value in cleaned}) != 3:
            raise ValueError("questions must be unique")
        return cleaned


class EvidenceGradeRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question: str = Field(min_length=1, max_length=2_000)
    article_title: str = Field(alias="articleTitle", min_length=1, max_length=500)
    evidence: list[EvidenceItem] = Field(default_factory=list, max_length=12)


class EvidenceGrade(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    sufficient: bool
    research_required: bool = Field(alias="researchRequired")
    confidence: Literal["high", "medium", "low"]
    reason_code: str = Field(alias="reasonCode", min_length=1, max_length=100)
    missing_information: list[str] = Field(
        alias="missingInformation", default_factory=list, max_length=5
    )
    search_queries: list[str] = Field(
        alias="searchQueries", default_factory=list, max_length=2
    )


QuestionRouteName = Literal[
    "article",
    "general",
    "web_search",
    "parallel_fallback",
    "insufficient",
]


class RouteQuestionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question: str = Field(min_length=1, max_length=2_000)
    article_title: str = Field(alias="articleTitle", min_length=1, max_length=500)
    conversation_summary: str = Field(
        alias="conversationSummary", default="", max_length=8_000
    )
    recent_messages: list[ConversationMessage] = Field(
        alias="recentMessages", default_factory=list, max_length=10
    )
    evidence: list[EvidenceItem] = Field(default_factory=list, max_length=8)


class QuestionRoute(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    route: QuestionRouteName
    reason: str = Field(min_length=1, max_length=500)
    confidence: Literal["high", "medium", "low"]
    search_query: str | None = Field(
        alias="searchQuery", default=None, max_length=500
    )


AnswerMode = Literal[
    "article",
    "general",
    "media",
    "web_search",
    "combined",
    "insufficient",
    "guardrail",
]


class AnswerQuestionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question: str = Field(min_length=1, max_length=2_000)
    article_title: str = Field(alias="articleTitle", min_length=1, max_length=500)
    route: AnswerMode
    conversation_summary: str = Field(
        alias="conversationSummary", default="", max_length=8_000
    )
    recent_messages: list[ConversationMessage] = Field(
        alias="recentMessages", default_factory=list, max_length=10
    )
    evidence: list[EvidenceItem] = Field(default_factory=list, max_length=12)
    general_candidate: str = Field(
        alias="generalCandidate", default="", max_length=8_000
    )
    correction: str = Field(default="", max_length=2_000)


class AnswerResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    answer: str = Field(min_length=1, max_length=8_000)
    answer_mode: AnswerMode = Field(alias="answerMode")
    used_evidence_ids: list[str] = Field(
        alias="usedEvidenceIds", default_factory=list, max_length=12
    )


class JudgeAnswerRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question: str = Field(min_length=1, max_length=2_000)
    answer: str = Field(min_length=1, max_length=8_000)
    answer_mode: AnswerMode = Field(alias="answerMode")
    evidence: list[EvidenceItem] = Field(default_factory=list, max_length=12)


class AnswerJudgment(BaseModel):
    decision: Literal["pass", "revise"]
    correction: str = Field(default="", max_length=2_000)


class SummarizeConversationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    existing_summary: str = Field(
        alias="existingSummary", default="", max_length=8_000
    )
    messages: list[ConversationMessage] = Field(min_length=1, max_length=12)


class ConversationSummary(BaseModel):
    summary: str = Field(min_length=1, max_length=4_000)


class SuperviseAnswerRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question: str = Field(min_length=1, max_length=2_000)
    article_title: str = Field(alias="articleTitle", min_length=1, max_length=500)
    conversation_summary: str = Field(
        alias="conversationSummary", default="", max_length=8_000
    )
    recent_messages: list[ConversationMessage] = Field(
        alias="recentMessages", default_factory=list, max_length=10
    )
    evidence: list[EvidenceItem] = Field(default_factory=list, max_length=12)
    evidence_grade: EvidenceGrade = Field(alias="evidenceGrade")


class SupervisedAnswer(BaseModel):
    answer: AnswerResult
    evidence: list[EvidenceItem] = Field(default_factory=list, max_length=20)


class PaperPage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page_number: int = Field(alias="pageNumber", gt=0)
    text: str


class PaperRelevance(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    is_ai_related: bool = Field(alias="isAiRelated")
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=500)


class PaperInspectionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    title: str = Field(min_length=1, max_length=500)
    page_count: int = Field(alias="pageCount", gt=0, le=150)
    pages: list[PaperPage] = Field(min_length=1, max_length=150)
    relevance: PaperRelevance


class EmbedPaperPagesRequest(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    pages: list[PaperPage] = Field(min_length=1, max_length=150)


class EmbeddedPaperChunk(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page_number: int = Field(alias="pageNumber", gt=0)
    chunk_index: int = Field(alias="chunkIndex", ge=0)
    content: str = Field(min_length=1)
    embedding: list[float] = Field(min_length=1)


class EmbedPaperPagesResponse(BaseModel):
    model: str
    dimensions: int = Field(gt=0)
    chunks: list[EmbeddedPaperChunk]


class PaperSelectionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    paper_title: str = Field(alias="paperTitle", min_length=1, max_length=500)
    page_number: int = Field(alias="pageNumber", gt=0)
    selected_text: str = Field(alias="selectedText", min_length=1, max_length=8_000)
    surrounding_context: str = Field(
        alias="surroundingContext", min_length=1, max_length=12_000
    )
    additional_evidence: list[PaperPage] = Field(
        alias="additionalEvidence", default_factory=list, max_length=3
    )


class PaperSelectionExplanation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    simple_explanation: str = Field(alias="simpleExplanation", min_length=1, max_length=4_000)
    why_it_matters: str = Field(alias="whyItMatters", min_length=1, max_length=2_000)
    example: str | None = Field(default=None, max_length=2_000)
    important_terms: list[str] = Field(alias="importantTerms", default_factory=list, max_length=8)
    page_citations: list[int] = Field(alias="pageCitations", min_length=1, max_length=4)


class PaperFigureRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    paper_title: str = Field(alias="paperTitle", min_length=1, max_length=500)
    page_number: int = Field(alias="pageNumber", gt=0)
    page_context: str = Field(alias="pageContext", min_length=1, max_length=8_000)
    image_base64: str = Field(alias="imageBase64", min_length=1)
    mime_type: Literal["image/png", "image/jpeg", "image/webp"] = Field(alias="mimeType")


class PaperFigureExplanation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    explanation: str = Field(min_length=1, max_length=4_000)
    relation_to_paper: str = Field(alias="relationToPaper", min_length=1, max_length=2_000)
    key_details: list[str] = Field(alias="keyDetails", default_factory=list, max_length=6)
    uncertainty: str | None = Field(default=None, max_length=1_000)
    page_citations: list[int] = Field(alias="pageCitations", min_length=1, max_length=2)


class PaperEvidence(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(min_length=1, max_length=100)
    page_number: int = Field(alias="pageNumber", gt=0)
    content: str = Field(min_length=1, max_length=8_000)


class PaperQuestionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question: str = Field(min_length=1, max_length=2_000)
    paper_title: str = Field(alias="paperTitle", min_length=1, max_length=500)
    requested_answer_mode: Literal["paper", "general"] = Field(
        alias="requestedAnswerMode", default="paper"
    )
    evidence: list[PaperEvidence] = Field(default_factory=list, max_length=5)


class PaperEvidenceDecision(BaseModel):
    sufficient: bool
    confidence: Literal["high", "medium", "low"]
    reason: str = Field(min_length=1, max_length=500)


class PaperQuestionAnswer(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    answer: str = Field(min_length=1, max_length=8_000)
    answer_mode: Literal["paper", "general"] = Field(alias="answerMode")
    label: str = Field(min_length=1, max_length=120)
    page_citations: list[int] = Field(alias="pageCitations", default_factory=list, max_length=8)
