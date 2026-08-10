import logging
import asyncio

from fastapi import FastAPI, File, HTTPException, UploadFile

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
        state = await article_workflow().ainvoke({"request": request})
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
        state = await keyword_workflow().ainvoke({"request": request})
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
        state = await ranking_workflow().ainvoke({"request": request})
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
        state = await feed_summary_workflow().ainvoke({"request": request})
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
        return await asyncio.to_thread(embed_document, request)
    except Exception as error:
        logger.exception("Document embedding failed")
        raise HTTPException(
            status_code=502, detail="Document embedding failed"
        ) from error


@app.post("/ai/embed-query", response_model=EmbedQueryResponse)
async def embed_query(request: EmbedQueryRequest) -> EmbedQueryResponse:
    try:
        return await asyncio.to_thread(embed_question, request.query)
    except Exception as error:
        logger.exception("Query embedding failed")
        raise HTTPException(
            status_code=502, detail="Query embedding failed"
        ) from error


@app.post("/ai/embed-paper-query", response_model=EmbedQueryResponse)
async def embed_paper_query(request: EmbedQueryRequest) -> EmbedQueryResponse:
    try:
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
        state = await route_question_workflow().ainvoke({"request": request})
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
        state = await answer_question_workflow().ainvoke({"request": request})
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
        state = await judge_answer_workflow().ainvoke({"request": request})
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
        state = await summarize_conversation_workflow().ainvoke(
            {"request": request}
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
        state = await scope_question_workflow().ainvoke({"request": request})
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
        state = await suggested_questions_workflow().ainvoke({"request": request})
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
        state = await analyze_media_workflow().ainvoke({"request": request})
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
        state = await grade_evidence_workflow().ainvoke({"request": request})
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
        state = await supervise_answer_workflow().ainvoke({"request": request})
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
        state = await paper_relevance_workflow().ainvoke({
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
        state = await paper_selection_workflow().ainvoke({"request": request})
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
        state = await paper_figure_workflow().ainvoke({"request": request})
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
        state = await paper_question_workflow().ainvoke({"request": request})
        return state["result"]
    except Exception as error:
        logger.exception("Paper question answering failed")
        raise HTTPException(status_code=502, detail="Paper question answering failed") from error
