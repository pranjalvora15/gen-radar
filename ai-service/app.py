import logging
import asyncio
import hmac
import os

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from models import (
    AnalyzeMediaRequest,
    AnswerJudgment,
    AnswerQuestionRequest,
    AnswerResult,
    ArticleExplanation,
    ArticleRequest,
    CandidateRankingRequest,
    CandidateRankingResponse,
    ConversationSummary,
    EvidenceGrade,
    EvidenceGradeRequest,
    EmbedDocumentsRequest,
    EmbedDocumentsResponse,
    EmbedQueryRequest,
    EmbedQueryResponse,
    FeedSummaryRequest,
    FeedSummaryResponse,
    JudgeAnswerRequest,
    KeywordExplanation,
    KeywordRequest,
    MediaAnalysisResponse,
    QuestionRoute,
    RouteQuestionRequest,
    ScopeDecision,
    ScopeQuestionRequest,
    SuggestedQuestions,
    SuggestedQuestionsRequest,
    SummarizeConversationRequest,
    SupervisedAnswer,
    SuperviseAnswerRequest,
    EmbedPaperPagesRequest,
    EmbedPaperPagesResponse,
    PaperFigureExplanation,
    PaperFigureRequest,
    PaperInspectionResponse,
    PaperQuestionAnswer,
    PaperQuestionRequest,
    PaperSelectionExplanation,
    PaperSelectionRequest,
)
from embeddings import (
    embed_document,
    embed_paper_pages,
    embed_paper_question,
    embed_question,
)
from paper_processing import PaperValidationError, inspect_pdf
from observability import (
    invoke_private_workflow,
    invoke_public_operation,
    invoke_public_workflow,
    private_tracing_disabled,
)
from paper_workflows import (
    paper_figure_workflow,
    paper_question_workflow,
    paper_relevance_workflow,
    paper_selection_workflow,
)
from workflows import (
    analyze_media_workflow,
    answer_question_workflow,
    article_workflow,
    judge_answer_workflow,
    keyword_workflow,
    grade_evidence_workflow,
    feed_summary_workflow,
    ranking_workflow,
    route_question_workflow,
    scope_question_workflow,
    suggested_questions_workflow,
    supervise_answer_workflow,
    summarize_conversation_workflow,
)

logger = logging.getLogger(__name__)

app = FastAPI(title="GenAI Updates AI Service", version="0.1.0")


@app.middleware("http")
async def require_internal_api_key(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)

    expected_key = os.getenv("AI_INTERNAL_API_KEY", "")
    if not expected_key:
        if os.getenv("ENVIRONMENT", "development") == "production":
            return JSONResponse(
                status_code=503,
                content={"detail": "AI service authentication is not configured"},
            )
        return await call_next(request)

    provided_key = request.headers.get("x-internal-api-key", "")
    if not hmac.compare_digest(provided_key, expected_key):
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})

    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
 

@app.post(
    "/ai/explain-article",
    response_model=ArticleExplanation,
    response_model_by_alias=True,
)
async def explain_article(request: ArticleRequest) -> ArticleExplanation:
    try:
        state = await invoke_public_workflow(
            article_workflow(),
            {"request": request},
            feature="article-explanation",
            run_name="explain_article",
        )
        return state["result"]
    except Exception as error:
        raise HTTPException(
            status_code=502, detail="Article explanation failed validation"
        ) from error


@app.post(
    "/ai/explain-keyword",
    response_model=KeywordExplanation,
    response_model_by_alias=True,
)
async def explain_keyword(request: KeywordRequest) -> KeywordExplanation:
    try:
        state = await invoke_public_workflow(
            keyword_workflow(),
            {"request": request},
            feature="keyword-explanation",
            run_name="explain_keyword",
        )
        return state["result"]
    except Exception as error:
        raise HTTPException(
            status_code=502, detail="Keyword explanation failed validation"
        ) from error


@app.post(
    "/ai/rank-candidates",
    response_model=CandidateRankingResponse,
    response_model_by_alias=True,
)
async def rank_candidates(
    request: CandidateRankingRequest,
) -> CandidateRankingResponse:
    try:
        state = await invoke_public_workflow(
            ranking_workflow(),
            {"request": request},
            feature="candidate-ranking",
            run_name="rank_candidates",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Candidate ranking failed")
        raise HTTPException(
            status_code=502, detail="Candidate ranking failed validation"
        ) from error


@app.post(
    "/ai/summarize-feed-articles",
    response_model=FeedSummaryResponse,
)
async def summarize_feed_articles(
    request: FeedSummaryRequest,
) -> FeedSummaryResponse:
    try:
        state = await invoke_public_workflow(
            feed_summary_workflow(),
            {"request": request},
            feature="feed-summary",
            run_name="summarize_feed_articles",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Feed summary generation failed")
        raise HTTPException(
            status_code=502, detail="Feed summary generation failed validation"
        ) from error


@app.post("/ai/embed-documents", response_model=EmbedDocumentsResponse)
async def embed_documents(
    request: EmbedDocumentsRequest,
) -> EmbedDocumentsResponse:
    try:
        return await invoke_public_operation(
            lambda: asyncio.to_thread(embed_document, request),
            feature="article-embedding",
        )
    except Exception as error:
        logger.exception("Document embedding failed")
        raise HTTPException(
            status_code=502, detail="Document embedding failed"
        ) from error


@app.post("/ai/embed-query", response_model=EmbedQueryResponse)
async def embed_query(request: EmbedQueryRequest) -> EmbedQueryResponse:
    try:
        return await invoke_public_operation(
            lambda: asyncio.to_thread(embed_question, request.query),
            feature="article-query-embedding",
        )
    except Exception as error:
        logger.exception("Query embedding failed")
        raise HTTPException(
            status_code=502, detail="Query embedding failed"
        ) from error


@app.post("/ai/embed-paper-query", response_model=EmbedQueryResponse)
async def embed_paper_query(request: EmbedQueryRequest) -> EmbedQueryResponse:
    try:
        with private_tracing_disabled():
            return await asyncio.to_thread(embed_paper_question, request.query)
    except Exception as error:
        logger.exception("Paper query embedding failed")
        raise HTTPException(
            status_code=502, detail="Paper query embedding failed"
        ) from error


@app.post(
    "/ai/route-question",
    response_model=QuestionRoute,
    response_model_by_alias=True,
)
async def route_question(request: RouteQuestionRequest) -> QuestionRoute:
    try:
        state = await invoke_public_workflow(
            route_question_workflow(),
            {"request": request},
            feature="question-routing",
            run_name="route_question",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Question routing failed")
        raise HTTPException(
            status_code=502, detail="Question routing failed"
        ) from error


@app.post(
    "/ai/answer-question",
    response_model=AnswerResult,
    response_model_by_alias=True,
)
async def answer_question(request: AnswerQuestionRequest) -> AnswerResult:
    try:
        state = await invoke_public_workflow(
            answer_question_workflow(),
            {"request": request},
            feature="article-question-answer",
            run_name="answer_question",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Question answering failed")
        raise HTTPException(
            status_code=502, detail="Question answering failed"
        ) from error


@app.post(
    "/ai/judge-answer",
    response_model=AnswerJudgment,
)
async def judge_answer(request: JudgeAnswerRequest) -> AnswerJudgment:
    try:
        state = await invoke_public_workflow(
            judge_answer_workflow(),
            {"request": request},
            feature="answer-review",
            run_name="judge_answer",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Answer verification failed")
        raise HTTPException(
            status_code=502, detail="Answer verification failed"
        ) from error


@app.post(
    "/ai/summarize-conversation",
    response_model=ConversationSummary,
)
async def summarize_conversation(
    request: SummarizeConversationRequest,
) -> ConversationSummary:
    try:
        state = await invoke_public_workflow(
            summarize_conversation_workflow(),
            {"request": request},
            feature="conversation-summary",
            run_name="summarize_conversation",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Conversation summarization failed")
        raise HTTPException(
            status_code=502, detail="Conversation summarization failed"
        ) from error


@app.post(
    "/ai/check-question-scope",
    response_model=ScopeDecision,
    response_model_by_alias=True,
)
async def check_question_scope(request: ScopeQuestionRequest) -> ScopeDecision:
    try:
        state = await invoke_public_workflow(
            scope_question_workflow(),
            {"request": request},
            feature="scope-guardrail",
            run_name="check_question_scope",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Scope guardrail failed")
        raise HTTPException(status_code=502, detail="Scope guardrail failed") from error


@app.post(
    "/ai/suggest-questions",
    response_model=SuggestedQuestions,
)
async def suggest_questions(request: SuggestedQuestionsRequest) -> SuggestedQuestions:
    try:
        state = await invoke_public_workflow(
            suggested_questions_workflow(),
            {"request": request},
            feature="suggested-questions",
            run_name="suggest_questions",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Question suggestion failed")
        raise HTTPException(
            status_code=502, detail="Question suggestion failed"
        ) from error


@app.post(
    "/ai/analyze-media",
    response_model=MediaAnalysisResponse,
    response_model_by_alias=True,
)
async def analyze_media(request: AnalyzeMediaRequest) -> MediaAnalysisResponse:
    try:
        state = await invoke_public_workflow(
            analyze_media_workflow(),
            {"request": request},
            feature="article-media-analysis",
            run_name="analyze_media",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Media analysis failed")
        raise HTTPException(status_code=502, detail="Media analysis failed") from error


@app.post(
    "/ai/grade-evidence",
    response_model=EvidenceGrade,
    response_model_by_alias=True,
)
async def grade_evidence(request: EvidenceGradeRequest) -> EvidenceGrade:
    try:
        state = await invoke_public_workflow(
            grade_evidence_workflow(),
            {"request": request},
            feature="evidence-grading",
            run_name="grade_evidence",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Evidence grading failed")
        raise HTTPException(status_code=502, detail="Evidence grading failed") from error


@app.post(
    "/ai/supervise-answer",
    response_model=SupervisedAnswer,
    response_model_by_alias=True,
)
async def supervise_answer(request: SuperviseAnswerRequest) -> SupervisedAnswer:
    try:
        state = await invoke_public_workflow(
            supervise_answer_workflow(),
            {"request": request},
            feature="multi-agent-supervision",
            run_name="supervise_answer",
        )
        return state["result"]
    except Exception as error:
        logger.exception("Multi-agent answer workflow failed")
        raise HTTPException(
            status_code=502, detail="Multi-agent answer workflow failed"
        ) from error


@app.post(
    "/ai/inspect-paper",
    response_model=PaperInspectionResponse,
    response_model_by_alias=True,
)
async def inspect_paper(file: UploadFile = File(...)) -> PaperInspectionResponse:
    try:
        title, pages, sample = await asyncio.to_thread(inspect_pdf, file.file)
        state = await invoke_private_workflow(paper_relevance_workflow(), {
            "title": title,
            "sample": sample,
        })
        relevance = state["result"]
        return PaperInspectionResponse(
            title=title,
            pageCount=len(pages),
            pages=pages,
            relevance=relevance,
        )
    except PaperValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        logger.exception("Paper inspection failed")
        raise HTTPException(status_code=502, detail="Paper inspection failed") from error
    finally:
        await file.close()


@app.post(
    "/ai/embed-paper-pages",
    response_model=EmbedPaperPagesResponse,
    response_model_by_alias=True,
)
async def embed_pages(request: EmbedPaperPagesRequest) -> EmbedPaperPagesResponse:
    try:
        with private_tracing_disabled():
            return await asyncio.to_thread(embed_paper_pages, request)
    except Exception as error:
        logger.exception("Paper page embedding failed")
        raise HTTPException(status_code=502, detail="Paper page embedding failed") from error


@app.post(
    "/ai/explain-paper-selection",
    response_model=PaperSelectionExplanation,
    response_model_by_alias=True,
)
async def explain_paper_selection(
    request: PaperSelectionRequest,
) -> PaperSelectionExplanation:
    try:
        state = await invoke_private_workflow(
            paper_selection_workflow(), {"request": request}
        )
        return state["result"]
    except Exception as error:
        logger.exception("Paper selection explanation failed")
        raise HTTPException(status_code=502, detail="Paper selection explanation failed") from error


@app.post(
    "/ai/explain-paper-figure",
    response_model=PaperFigureExplanation,
    response_model_by_alias=True,
)
async def explain_paper_figure(
    request: PaperFigureRequest,
) -> PaperFigureExplanation:
    try:
        state = await invoke_private_workflow(
            paper_figure_workflow(), {"request": request}
        )
        return state["result"]
    except Exception as error:
        logger.exception("Paper figure explanation failed")
        raise HTTPException(status_code=502, detail="Paper figure explanation failed") from error


@app.post(
    "/ai/answer-paper-question",
    response_model=PaperQuestionAnswer,
    response_model_by_alias=True,
)
async def answer_paper_question(request: PaperQuestionRequest) -> PaperQuestionAnswer:
    try:
        state = await invoke_private_workflow(
            paper_question_workflow(), {"request": request}
        )
        return state["result"]
    except Exception as error:
        logger.exception("Paper question answering failed")
        raise HTTPException(status_code=502, detail="Paper question answering failed") from error
