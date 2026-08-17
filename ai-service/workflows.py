import base64
import asyncio
import json
import mimetypes
from functools import lru_cache
from typing import TypedDict
from urllib.parse import quote, urlparse

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
import httpx

from llm import get_judge_llm, get_llm
from gemini_runtime import (
    INTERACTIVE_PRIORITY,
    gemini_coordinator,
)
from models import (
    AnalyzeMediaRequest,
    AnswerJudgment,
    AnswerQuestionRequest,
    AnswerResult,
    ArticleExplanation,
    ArticleRequest,
    CandidateRankingRequest,
    CandidateRankingResponse,
    FeedSummaryRequest,
    FeedSummaryResponse,
    ConversationSummary,
    EvidenceGrade,
    EvidenceGradeRequest,
    MediaAnalysisResponse,
    JudgeAnswerRequest,
    KeywordExplanation,
    KeywordRequest,
    QuestionRoute,
    RouteQuestionRequest,
    ScopeDecision,
    ScopeQuestionRequest,
    SuggestedQuestions,
    SuggestedQuestionsRequest,
    SummarizeConversationRequest,
    SupervisedAnswer,
    SuperviseAnswerRequest,
)

IMAGE_PROXY_URL = "https://wsrv.nl/?url="
IMAGE_MAX_BYTES = 8 * 1024 * 1024


def download_image(url: str) -> tuple[bytes, str]:
    candidates = [url]
    if urlparse(url).hostname not in {"wsrv.nl", "images.weserv.nl"}:
        candidates.append(f"{IMAGE_PROXY_URL}{quote(url, safe='')}")

    last_error: Exception | None = None
    for candidate in candidates:
        try:
            response = httpx.get(
                candidate,
                timeout=30,
                follow_redirects=True,
                headers={"User-Agent": "GenRadar/1.0"},
            )
            response.raise_for_status()
            mime_type = response.headers.get("content-type", "").split(";")[0]
            if not mime_type.startswith("image/"):
                raise ValueError("URL did not return an image")
            if len(response.content) > IMAGE_MAX_BYTES:
                raise ValueError("Image exceeds the 8 MB analysis limit")
            return response.content, mime_type
        except Exception as error:
            last_error = error
    raise ValueError("Image could not be downloaded") from last_error
from prompts import (
    ANSWER_SYSTEM_PROMPT,
    ANSWER_USER_TEMPLATE,
    ARTICLE_SYSTEM_PROMPT,
    ARTICLE_USER_TEMPLATE,
    JUDGE_SYSTEM_PROMPT,
    JUDGE_USER_TEMPLATE,
    KEYWORD_SYSTEM_PROMPT,
    KEYWORD_USER_TEMPLATE,
    RANKING_SYSTEM_PROMPT,
    RANKING_USER_TEMPLATE,
    ROUTE_SYSTEM_PROMPT,
    ROUTE_USER_TEMPLATE,
    EVIDENCE_GRADE_SYSTEM_PROMPT,
    EVIDENCE_GRADE_USER_TEMPLATE,
    MEDIA_SYSTEM_PROMPT,
    MEDIA_USER_TEMPLATE,
    FEED_SUMMARY_SYSTEM_PROMPT,
    FEED_SUMMARY_USER_TEMPLATE,
    SCOPE_SYSTEM_PROMPT,
    SCOPE_USER_TEMPLATE,
    SPECIALIST_SYSTEM_PROMPT,
    SUGGESTIONS_SYSTEM_PROMPT,
    SUGGESTIONS_USER_TEMPLATE,
    SUPERVISOR_SYSTEM_PROMPT,
    SUMMARY_SYSTEM_PROMPT,
    SUMMARY_USER_TEMPLATE,
)
from research import search_web


class ArticleState(TypedDict, total=False):
    request: ArticleRequest
    messages: list
    generated: ArticleExplanation
    result: ArticleExplanation


class KeywordState(TypedDict, total=False):
    request: KeywordRequest
    messages: list
    generated: KeywordExplanation
    result: KeywordExplanation


class RankingState(TypedDict, total=False):
    request: CandidateRankingRequest
    messages: list
    generated: CandidateRankingResponse
    result: CandidateRankingResponse


class FeedSummaryState(TypedDict, total=False):
    request: FeedSummaryRequest
    messages: list
    generated: FeedSummaryResponse
    result: FeedSummaryResponse


class RouteState(TypedDict, total=False):
    request: RouteQuestionRequest
    messages: list
    generated: QuestionRoute
    result: QuestionRoute


class AnswerState(TypedDict, total=False):
    request: AnswerQuestionRequest
    messages: list
    generated: AnswerResult
    result: AnswerResult


class JudgeState(TypedDict, total=False):
    request: JudgeAnswerRequest
    messages: list
    generated: AnswerJudgment
    result: AnswerJudgment


class SummaryState(TypedDict, total=False):
    request: SummarizeConversationRequest
    messages: list
    generated: ConversationSummary
    result: ConversationSummary


class ScopeState(TypedDict, total=False):
    request: ScopeQuestionRequest
    messages: list
    generated: ScopeDecision
    result: ScopeDecision


class SuggestionsState(TypedDict, total=False):
    request: SuggestedQuestionsRequest
    messages: list
    generated: SuggestedQuestions
    result: SuggestedQuestions


class MediaState(TypedDict, total=False):
    request: AnalyzeMediaRequest
    messages: list
    generated: MediaAnalysisResponse
    result: MediaAnalysisResponse


class EvidenceGradeState(TypedDict, total=False):
    request: EvidenceGradeRequest
    messages: list
    generated: EvidenceGrade
    result: EvidenceGrade


class SupervisorState(TypedDict, total=False):
    request: SuperviseAnswerRequest
    document_draft: AnswerResult | None
    media_draft: AnswerResult | None
    research_draft: AnswerResult | None
    evidence: list
    answer: AnswerResult
    judgment: AnswerJudgment
    result: SupervisedAnswer


def parse_json_object(content) -> dict:
    if isinstance(content, list):
        content = "\n".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    if not isinstance(content, str):
        raise ValueError("structured response content must be text")
    text = content.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        text = text[first_newline + 1 :] if first_newline >= 0 else text[3:]
        if text.endswith("```"):
            text = text[:-3]
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("structured response did not contain a JSON object")
    value = json.loads(text[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("structured response must be a JSON object")
    return value


def structured_payload_from_raw(raw) -> dict:
    tool_calls = getattr(raw, "tool_calls", None) or []
    for tool_call in tool_calls:
        args = tool_call.get("args") if isinstance(tool_call, dict) else None
        if isinstance(args, dict):
            return args
        if isinstance(args, str):
            return parse_json_object(args)

    additional_kwargs = getattr(raw, "additional_kwargs", {}) or {}
    provider_calls = additional_kwargs.get("tool_calls", [])
    for tool_call in provider_calls:
        arguments = tool_call.get("function", {}).get("arguments")
        if isinstance(arguments, dict):
            return arguments
        if isinstance(arguments, str):
            return parse_json_object(arguments)

    content = getattr(raw, "content", "")
    return parse_json_object(content)


async def invoke_structured(
    model_class,
    messages: list,
    llm=None,
    *,
    priority: str = INTERACTIVE_PRIORITY,
):
    chain = (llm or get_llm()).with_structured_output(
        model_class, include_raw=True
    )

    async def invoke_and_validate():
        response = await chain.ainvoke(messages)
        parsed = response.get("parsed")
        if parsed is not None:
            return model_class.model_validate(parsed)

        raw = response.get("raw")
        return model_class.model_validate(structured_payload_from_raw(raw))

    return await gemini_coordinator.run(
        invoke_and_validate,
        priority=priority,
        operation_name=model_class.__name__,
    )


def prepare_article(state: ArticleState) -> ArticleState:
    request = state["request"]
    content = " ".join(request.content.split())[:100_000]
    user_message = ARTICLE_USER_TEMPLATE.format(
        title=request.title.strip(),
        source_name=request.source_name.strip(),
        url=request.url.strip(),
        content=content,
    )
    return {
        "messages": [
            SystemMessage(content=ARTICLE_SYSTEM_PROMPT),
            HumanMessage(content=user_message),
        ]
    }


async def generate_article(state: ArticleState) -> ArticleState:
    return {
        "generated": await invoke_structured(ArticleExplanation, state["messages"])
    }


def validate_article(state: ArticleState) -> ArticleState:
    generated = state["generated"]
    return {
        "result": ArticleExplanation.model_validate(
            generated.model_dump(by_alias=True)
        )
    }


def prepare_keyword(state: KeywordState) -> KeywordState:
    request = state["request"]
    content = " ".join(request.content.split())[:10_000]
    explanation = json.dumps(request.article_explanation, ensure_ascii=True)
    user_message = KEYWORD_USER_TEMPLATE.format(
        keyword=request.keyword.strip(),
        title=request.title.strip(),
        content=content,
        article_explanation=explanation[:6_000],
    )
    return {
        "messages": [
            SystemMessage(content=KEYWORD_SYSTEM_PROMPT),
            HumanMessage(content=user_message),
        ]
    }


async def generate_keyword(state: KeywordState) -> KeywordState:
    return {
        "generated": await invoke_structured(KeywordExplanation, state["messages"])
    }


def validate_keyword(state: KeywordState) -> KeywordState:
    generated = state["generated"]
    return {
        "result": KeywordExplanation.model_validate(
            generated.model_dump(by_alias=True)
        )
    }


def prepare_ranking(state: RankingState) -> RankingState:
    request = state["request"]
    candidates = json.dumps(
        [
            candidate.model_dump(by_alias=True)
            for candidate in request.candidates
        ],
        ensure_ascii=True,
    )
    return {
        "messages": [
            SystemMessage(content=RANKING_SYSTEM_PROMPT),
            HumanMessage(
                content=RANKING_USER_TEMPLATE.format(candidates=candidates)
            ),
        ]
    }


async def generate_ranking(state: RankingState) -> RankingState:
    return {
        "generated": await invoke_structured(
            CandidateRankingResponse, state["messages"]
        )
    }


def validate_ranking(state: RankingState) -> RankingState:
    generated = state["generated"]
    return {
        "result": CandidateRankingResponse.model_validate(
            generated.model_dump(by_alias=True)
        )
    }


def prepare_feed_summaries(state: FeedSummaryState) -> FeedSummaryState:
    articles = json.dumps(
        [article.model_dump(by_alias=True) for article in state["request"].articles],
        ensure_ascii=True,
    )
    return {
        "messages": [
            SystemMessage(content=FEED_SUMMARY_SYSTEM_PROMPT),
            HumanMessage(
                content=FEED_SUMMARY_USER_TEMPLATE.format(articles=articles)
            ),
        ]
    }


async def generate_feed_summaries(
    state: FeedSummaryState,
) -> FeedSummaryState:
    return {
        "generated": await invoke_structured(
            FeedSummaryResponse, state["messages"]
        )
    }


def validate_feed_summaries(state: FeedSummaryState) -> FeedSummaryState:
    requested_ids = {article.id for article in state["request"].articles}
    generated = [
        summary
        for summary in state["generated"].summaries
        if summary.id in requested_ids
    ]
    if {summary.id for summary in generated} != requested_ids:
        raise ValueError("Feed summary response did not cover every article")
    return {"result": FeedSummaryResponse(summaries=generated)}


def serialize_models(values: list) -> str:
    return json.dumps(
        [
            value.model_dump(by_alias=True)
            if hasattr(value, "model_dump")
            else value
            for value in values
        ],
        ensure_ascii=False,
    )


def prepare_route(state: RouteState) -> RouteState:
    request = state["request"]
    return {
        "messages": [
            SystemMessage(content=ROUTE_SYSTEM_PROMPT),
            HumanMessage(
                content=ROUTE_USER_TEMPLATE.format(
                    article_title=request.article_title,
                    conversation_summary=request.conversation_summary or "None",
                    recent_messages=serialize_models(request.recent_messages),
                    question=request.question,
                    evidence=serialize_models(request.evidence),
                )
            ),
        ]
    }


async def generate_route(state: RouteState) -> RouteState:
    return {
        "generated": await invoke_structured(QuestionRoute, state["messages"])
    }


def validate_route(state: RouteState) -> RouteState:
    generated = state["generated"]
    if (
        generated.route in {"web_search", "parallel_fallback"}
        and not generated.search_query
    ):
        generated.search_query = state["request"].question
    return {
        "result": QuestionRoute.model_validate(
            generated.model_dump(by_alias=True)
        )
    }


def prepare_answer(state: AnswerState) -> AnswerState:
    request = state["request"]
    return {
        "messages": [
            SystemMessage(content=ANSWER_SYSTEM_PROMPT),
            HumanMessage(
                content=ANSWER_USER_TEMPLATE.format(
                    article_title=request.article_title,
                    conversation_summary=request.conversation_summary or "None",
                    recent_messages=serialize_models(request.recent_messages),
                    question=request.question,
                    route=request.route,
                    evidence=serialize_models(request.evidence),
                    general_candidate=request.general_candidate or "None",
                    correction=request.correction or "None",
                )
            ),
        ]
    }


async def generate_answer(state: AnswerState) -> AnswerState:
    return {
        "generated": await invoke_structured(AnswerResult, state["messages"])
    }


def validate_answer(state: AnswerState) -> AnswerState:
    generated = state["generated"]
    request = state["request"]
    generated.answer_mode = request.route
    allowed_ids = {item.id for item in request.evidence}
    generated.used_evidence_ids = [
        item_id
        for item_id in generated.used_evidence_ids
        if item_id in allowed_ids
    ]
    if request.route == "general":
        generated.used_evidence_ids = []
    return {
        "result": AnswerResult.model_validate(
            generated.model_dump(by_alias=True)
        )
    }


def prepare_judgment(state: JudgeState) -> JudgeState:
    request = state["request"]
    return {
        "messages": [
            SystemMessage(content=JUDGE_SYSTEM_PROMPT),
            HumanMessage(
                content=JUDGE_USER_TEMPLATE.format(
                    question=request.question,
                    answer_mode=request.answer_mode,
                    answer=request.answer,
                    evidence=serialize_models(request.evidence),
                )
            ),
        ]
    }


async def generate_judgment(state: JudgeState) -> JudgeState:
    return {
        "generated": await invoke_structured(
            AnswerJudgment,
            state["messages"],
            llm=get_judge_llm(),
        )
    }


def validate_judgment(state: JudgeState) -> JudgeState:
    generated = state["generated"]
    if generated.decision == "revise" and not generated.correction.strip():
        generated.correction = "Remove or qualify unsupported claims."
    return {
        "result": AnswerJudgment.model_validate(generated.model_dump())
    }


def prepare_summary(state: SummaryState) -> SummaryState:
    request = state["request"]
    return {
        "messages": [
            SystemMessage(content=SUMMARY_SYSTEM_PROMPT),
            HumanMessage(
                content=SUMMARY_USER_TEMPLATE.format(
                    existing_summary=request.existing_summary or "None",
                    messages=serialize_models(request.messages),
                )
            ),
        ]
    }


async def generate_summary(state: SummaryState) -> SummaryState:
    return {
        "generated": await invoke_structured(
            ConversationSummary,
            state["messages"],
        )
    }


def validate_summary(state: SummaryState) -> SummaryState:
    return {
        "result": ConversationSummary.model_validate(
            state["generated"].model_dump()
        )
    }


def prepare_scope(state: ScopeState) -> ScopeState:
    request = state["request"]
    return {
        "messages": [
            SystemMessage(content=SCOPE_SYSTEM_PROMPT),
            HumanMessage(
                content=SCOPE_USER_TEMPLATE.format(
                    article_title=request.article_title,
                    article_context=request.article_context or "None",
                    conversation_summary=request.conversation_summary or "None",
                    recent_messages=serialize_models(request.recent_messages),
                    has_selected_image=request.has_selected_image,
                    selected_media_id=request.selected_media_id or "None",
                    selected_media_type=request.selected_media_type or "None",
                    media_analysis_completed=request.media_analysis_completed,
                    selected_media_analysis=(
                        request.selected_media_analysis or "Not available"
                    ),
                    question=request.question,
                )
            ),
        ]
    }


async def generate_scope(state: ScopeState) -> ScopeState:
    return {"generated": await invoke_structured(ScopeDecision, state["messages"])}


def validate_scope(state: ScopeState) -> ScopeState:
    decision = state["generated"]
    if decision.action == "continue":
        decision.allowed = True
    else:
        decision.allowed = False
    return {"result": ScopeDecision.model_validate(decision.model_dump(by_alias=True))}


def prepare_suggestions(state: SuggestionsState) -> SuggestionsState:
    request = state["request"]
    return {
        "messages": [
            SystemMessage(content=SUGGESTIONS_SYSTEM_PROMPT),
            HumanMessage(
                content=SUGGESTIONS_USER_TEMPLATE.format(
                    article_title=request.article_title,
                    article_context=request.article_context,
                    media_context=request.media_context or "None",
                )
            ),
        ]
    }


async def generate_suggestions(state: SuggestionsState) -> SuggestionsState:
    return {
        "generated": await invoke_structured(SuggestedQuestions, state["messages"])
    }


def validate_suggestions(state: SuggestionsState) -> SuggestionsState:
    return {
        "result": SuggestedQuestions.model_validate(
            state["generated"].model_dump()
        )
    }


def prepare_media(state: MediaState) -> MediaState:
    request = state["request"]
    content = [
        {
            "type": "text",
            "text": MEDIA_USER_TEMPLATE.format(
                article_title=request.article_title,
                article_context=request.article_context or "None",
                question=request.question or "None",
                media_id="multiple; preserve each supplied id",
                media_type="image or video as supplied",
            ),
        }
    ]
    for item in request.items:
        content.append({
            "type": "text",
            "text": f"MEDIA ITEM {item.id} ({item.media_type}): {item.url}",
        })
        if item.media_type == "video":
            mime_type = mimetypes.guess_type(item.url.split("?")[0])[0] or "video/mp4"
            content.append({
                "type": "video",
                "url": item.url,
                "mime_type": mime_type,
            })
            continue
        try:
            image_bytes, mime_type = download_image(item.url)
            content.append({
                "type": "image",
                "base64": base64.b64encode(image_bytes).decode("ascii"),
                "mime_type": mime_type,
            })
        except Exception:
            content.append({
                "type": "text",
                "text": f"Media item {item.id} could not be downloaded; mark it irrelevant.",
            })
    return {
        "messages": [
            SystemMessage(content=MEDIA_SYSTEM_PROMPT),
            HumanMessage(content=content),
        ]
    }


async def generate_media(state: MediaState) -> MediaState:
    return {
        "generated": await invoke_structured(
            MediaAnalysisResponse,
            state["messages"],
            priority=INTERACTIVE_PRIORITY,
        )
    }


def validate_media(state: MediaState) -> MediaState:
    request_ids = {item.id for item in state["request"].items}
    analyses = [
        item for item in state["generated"].analyses if item.id in request_ids
    ]
    returned_ids = {item.id for item in analyses}
    for item in state["request"].items:
        if item.id not in returned_ids:
            analyses.append(
                {
                    "id": item.id,
                    "mediaType": item.media_type,
                    "relevant": False,
                    "description": "",
                    "relationToArticle": "",
                    "keyDetails": [],
                    "timestamps": [],
                }
            )
    return {
        "result": MediaAnalysisResponse.model_validate(
            {"analyses": [
                item.model_dump(by_alias=True) if hasattr(item, "model_dump") else item
                for item in analyses
            ]}
        )
    }


def prepare_evidence_grade(state: EvidenceGradeState) -> EvidenceGradeState:
    request = state["request"]
    return {
        "messages": [
            SystemMessage(content=EVIDENCE_GRADE_SYSTEM_PROMPT),
            HumanMessage(
                content=EVIDENCE_GRADE_USER_TEMPLATE.format(
                    article_title=request.article_title,
                    question=request.question,
                    evidence=serialize_models(request.evidence),
                )
            ),
        ]
    }


async def generate_evidence_grade(state: EvidenceGradeState) -> EvidenceGradeState:
    return {"generated": await invoke_structured(EvidenceGrade, state["messages"])}


def validate_evidence_grade(
    state: EvidenceGradeState,
) -> EvidenceGradeState:
    grade = state["generated"]
    if grade.research_required and not grade.search_queries:
        grade.search_queries = [state["request"].question]
    return {"result": EvidenceGrade.model_validate(grade.model_dump(by_alias=True))}


async def specialist_answer(
    request: SuperviseAnswerRequest,
    evidence: list,
    agent_name: str,
    route: str,
) -> AnswerResult | None:
    if not evidence:
        return None
    messages = [
        SystemMessage(
            content=SPECIALIST_SYSTEM_PROMPT.format(agent_name=agent_name)
        ),
        HumanMessage(
            content=ANSWER_USER_TEMPLATE.format(
                article_title=request.article_title,
                conversation_summary=request.conversation_summary or "None",
                recent_messages=serialize_models(request.recent_messages),
                question=request.question,
                route=route,
                evidence=serialize_models(evidence),
                general_candidate="None",
                correction="None",
            )
        ),
    ]
    result = await invoke_structured(AnswerResult, messages)
    result.answer_mode = route
    allowed_ids = {item.id for item in evidence}
    result.used_evidence_ids = [
        item_id for item_id in result.used_evidence_ids if item_id in allowed_ids
    ]
    return result


async def document_agent(state: SupervisorState) -> SupervisorState:
    request = state["request"]
    evidence = [item for item in request.evidence if item.source_type == "article"]
    return {
        "document_draft": await specialist_answer(
            request, evidence, "Document Agent", "article"
        )
    }


async def media_agent(state: SupervisorState) -> SupervisorState:
    request = state["request"]
    evidence = [
        item for item in request.evidence if item.source_type in {"image", "video"}
    ]
    return {
        "media_draft": await specialist_answer(
            request, evidence, "Media Agent", "media"
        )
    }


async def research_agent(state: SupervisorState) -> SupervisorState:
    request = state["request"]
    if not request.evidence_grade.research_required:
        return {"research_draft": None, "evidence": request.evidence}
    web_evidence = await asyncio.to_thread(
        search_web, request.evidence_grade.search_queries
    )
    return {
        "research_draft": await specialist_answer(
            request, web_evidence, "Exa Research Agent", "web_search"
        ),
        "evidence": [*request.evidence, *web_evidence],
    }


async def supervisor_agent(state: SupervisorState) -> SupervisorState:
    request = state["request"]
    evidence = state.get("evidence") or request.evidence
    drafts = [
        draft.answer
        for draft in (
            state.get("document_draft"),
            state.get("media_draft"),
            state.get("research_draft"),
        )
        if draft is not None
    ]
    source_types = {item.source_type for item in evidence}
    if "web" in source_types and len(source_types) > 1:
        route = "combined"
    elif "web" in source_types:
        route = "web_search"
    elif source_types & {"image", "video"} and "article" not in source_types:
        route = "media"
    elif evidence:
        route = "article"
    else:
        route = "insufficient"

    messages = [
        SystemMessage(content=SUPERVISOR_SYSTEM_PROMPT),
        HumanMessage(
            content=ANSWER_USER_TEMPLATE.format(
                article_title=request.article_title,
                conversation_summary=request.conversation_summary or "None",
                recent_messages=serialize_models(request.recent_messages),
                question=request.question,
                route=route,
                evidence=serialize_models(evidence),
                general_candidate="\n\n".join(drafts) or "None",
                correction="None",
            )
        ),
    ]
    answer = await invoke_structured(AnswerResult, messages)
    answer.answer_mode = route
    allowed_ids = {item.id for item in evidence}
    answer.used_evidence_ids = [
        item_id for item_id in answer.used_evidence_ids if item_id in allowed_ids
    ]
    return {"answer": answer, "evidence": evidence}


async def reviewer_agent(state: SupervisorState) -> SupervisorState:
    request = state["request"]
    answer = state["answer"]
    evidence = state.get("evidence") or request.evidence
    messages = [
        SystemMessage(content=JUDGE_SYSTEM_PROMPT),
        HumanMessage(
            content=JUDGE_USER_TEMPLATE.format(
                question=request.question,
                answer_mode=answer.answer_mode,
                answer=answer.answer,
                evidence=serialize_models(evidence),
            )
        ),
    ]
    judgment = await invoke_structured(
        AnswerJudgment, messages, llm=get_judge_llm()
    )
    return {"judgment": judgment}


async def finalize_supervised_answer(state: SupervisorState) -> SupervisorState:
    request = state["request"]
    answer = state["answer"]
    evidence = state.get("evidence") or request.evidence
    judgment = state["judgment"]
    if judgment.decision == "revise":
        messages = [
            SystemMessage(content=SUPERVISOR_SYSTEM_PROMPT),
            HumanMessage(
                content=ANSWER_USER_TEMPLATE.format(
                    article_title=request.article_title,
                    conversation_summary=request.conversation_summary or "None",
                    recent_messages=serialize_models(request.recent_messages),
                    question=request.question,
                    route=answer.answer_mode,
                    evidence=serialize_models(evidence),
                    general_candidate=answer.answer,
                    correction=judgment.correction
                    or "Remove or qualify unsupported claims.",
                )
            ),
        ]
        answer = await invoke_structured(AnswerResult, messages)
        answer.answer_mode = state["answer"].answer_mode
    allowed_ids = {item.id for item in evidence}
    answer.used_evidence_ids = [
        item_id for item_id in answer.used_evidence_ids if item_id in allowed_ids
    ]
    return {
        "result": SupervisedAnswer(answer=answer, evidence=evidence)
    }


@lru_cache
def article_workflow():
    graph = StateGraph(ArticleState)
    graph.add_node("prepare_article", prepare_article)
    graph.add_node("generate_explanation", generate_article)
    graph.add_node("validate_explanation", validate_article)
    graph.add_edge(START, "prepare_article")
    graph.add_edge("prepare_article", "generate_explanation")
    graph.add_edge("generate_explanation", "validate_explanation")
    graph.add_edge("validate_explanation", END)
    return graph.compile()


@lru_cache
def keyword_workflow():
    graph = StateGraph(KeywordState)
    graph.add_node("prepare_keyword_context", prepare_keyword)
    graph.add_node("generate_keyword_explanation", generate_keyword)
    graph.add_node("validate_keyword_explanation", validate_keyword)
    graph.add_edge(START, "prepare_keyword_context")
    graph.add_edge("prepare_keyword_context", "generate_keyword_explanation")
    graph.add_edge("generate_keyword_explanation", "validate_keyword_explanation")
    graph.add_edge("validate_keyword_explanation", END)
    return graph.compile()


@lru_cache
def ranking_workflow():
    graph = StateGraph(RankingState)
    graph.add_node("prepare_candidates", prepare_ranking)
    graph.add_node("rank_candidates", generate_ranking)
    graph.add_node("validate_ranking", validate_ranking)
    graph.add_edge(START, "prepare_candidates")
    graph.add_edge("prepare_candidates", "rank_candidates")
    graph.add_edge("rank_candidates", "validate_ranking")
    graph.add_edge("validate_ranking", END)
    return graph.compile()


@lru_cache
def feed_summary_workflow():
    graph = StateGraph(FeedSummaryState)
    graph.add_node("prepare_articles", prepare_feed_summaries)
    graph.add_node("generate_summaries", generate_feed_summaries)
    graph.add_node("validate_summaries", validate_feed_summaries)
    graph.add_edge(START, "prepare_articles")
    graph.add_edge("prepare_articles", "generate_summaries")
    graph.add_edge("generate_summaries", "validate_summaries")
    graph.add_edge("validate_summaries", END)
    return graph.compile()


@lru_cache
def route_question_workflow():
    graph = StateGraph(RouteState)
    graph.add_node("prepare_question", prepare_route)
    graph.add_node("grade_context", generate_route)
    graph.add_node("validate_route", validate_route)
    graph.add_edge(START, "prepare_question")
    graph.add_edge("prepare_question", "grade_context")
    graph.add_edge("grade_context", "validate_route")
    graph.add_edge("validate_route", END)
    return graph.compile()


@lru_cache
def answer_question_workflow():
    graph = StateGraph(AnswerState)
    graph.add_node("prepare_answer", prepare_answer)
    graph.add_node("generate_answer", generate_answer)
    graph.add_node("validate_answer", validate_answer)
    graph.add_edge(START, "prepare_answer")
    graph.add_edge("prepare_answer", "generate_answer")
    graph.add_edge("generate_answer", "validate_answer")
    graph.add_edge("validate_answer", END)
    return graph.compile()


@lru_cache
def judge_answer_workflow():
    graph = StateGraph(JudgeState)
    graph.add_node("prepare_judgment", prepare_judgment)
    graph.add_node("judge_answer", generate_judgment)
    graph.add_node("validate_judgment", validate_judgment)
    graph.add_edge(START, "prepare_judgment")
    graph.add_edge("prepare_judgment", "judge_answer")
    graph.add_edge("judge_answer", "validate_judgment")
    graph.add_edge("validate_judgment", END)
    return graph.compile()


@lru_cache
def summarize_conversation_workflow():
    graph = StateGraph(SummaryState)
    graph.add_node("prepare_summary", prepare_summary)
    graph.add_node("summarize_conversation", generate_summary)
    graph.add_node("validate_summary", validate_summary)
    graph.add_edge(START, "prepare_summary")
    graph.add_edge("prepare_summary", "summarize_conversation")
    graph.add_edge("summarize_conversation", "validate_summary")
    graph.add_edge("validate_summary", END)
    return graph.compile()


@lru_cache
def scope_question_workflow():
    graph = StateGraph(ScopeState)
    graph.add_node("prepare_scope", prepare_scope)
    graph.add_node("scope_guardrail", generate_scope)
    graph.add_node("validate_scope", validate_scope)
    graph.add_edge(START, "prepare_scope")
    graph.add_edge("prepare_scope", "scope_guardrail")
    graph.add_edge("scope_guardrail", "validate_scope")
    graph.add_edge("validate_scope", END)
    return graph.compile()


@lru_cache
def suggested_questions_workflow():
    graph = StateGraph(SuggestionsState)
    graph.add_node("prepare_article", prepare_suggestions)
    graph.add_node("suggest_questions", generate_suggestions)
    graph.add_node("validate_suggestions", validate_suggestions)
    graph.add_edge(START, "prepare_article")
    graph.add_edge("prepare_article", "suggest_questions")
    graph.add_edge("suggest_questions", "validate_suggestions")
    graph.add_edge("validate_suggestions", END)
    return graph.compile()


@lru_cache
def analyze_media_workflow():
    graph = StateGraph(MediaState)
    graph.add_node("prepare_media", prepare_media)
    graph.add_node("media_agent", generate_media)
    graph.add_node("validate_media", validate_media)
    graph.add_edge(START, "prepare_media")
    graph.add_edge("prepare_media", "media_agent")
    graph.add_edge("media_agent", "validate_media")
    graph.add_edge("validate_media", END)
    return graph.compile()


@lru_cache
def grade_evidence_workflow():
    graph = StateGraph(EvidenceGradeState)
    graph.add_node("prepare_evidence", prepare_evidence_grade)
    graph.add_node("evidence_agent", generate_evidence_grade)
    graph.add_node("validate_grade", validate_evidence_grade)
    graph.add_edge(START, "prepare_evidence")
    graph.add_edge("prepare_evidence", "evidence_agent")
    graph.add_edge("evidence_agent", "validate_grade")
    graph.add_edge("validate_grade", END)
    return graph.compile()


@lru_cache
def supervise_answer_workflow():
    graph = StateGraph(SupervisorState)
    graph.add_node("document_agent", document_agent)
    graph.add_node("media_agent", media_agent)
    graph.add_node("research_agent", research_agent)
    graph.add_node("supervisor_agent", supervisor_agent)
    graph.add_node("reviewer_agent", reviewer_agent)
    graph.add_node("finalize", finalize_supervised_answer)
    graph.add_edge(START, "document_agent")
    graph.add_edge("document_agent", "media_agent")
    graph.add_edge("media_agent", "research_agent")
    graph.add_edge("research_agent", "supervisor_agent")
    graph.add_edge("supervisor_agent", "reviewer_agent")
    graph.add_edge("reviewer_agent", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()
