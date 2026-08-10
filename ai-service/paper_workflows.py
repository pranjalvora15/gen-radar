import json
from functools import lru_cache
from typing import TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

from gemini_runtime import INTERACTIVE_PRIORITY
from llm import get_judge_llm
from models import (
    PaperEvidenceDecision,
    PaperFigureExplanation,
    PaperFigureRequest,
    PaperQuestionAnswer,
    PaperQuestionRequest,
    PaperRelevance,
    PaperSelectionExplanation,
    PaperSelectionRequest,
)
from paper_prompts import (
    PAPER_ANSWER_SYSTEM_PROMPT,
    PAPER_ANSWER_USER_TEMPLATE,
    PAPER_EVIDENCE_SYSTEM_PROMPT,
    PAPER_EVIDENCE_USER_TEMPLATE,
    PAPER_FIGURE_SYSTEM_PROMPT,
    PAPER_FIGURE_USER_TEMPLATE,
    PAPER_RELEVANCE_SYSTEM_PROMPT,
    PAPER_RELEVANCE_USER_TEMPLATE,
    PAPER_SELECTION_SYSTEM_PROMPT,
    PAPER_SELECTION_USER_TEMPLATE,
)
from workflows import invoke_structured


class SimplePaperState(TypedDict, total=False):
    request: object
    title: str
    sample: str
    messages: list
    generated: object
    grade: PaperEvidenceDecision
    result: object


def prepare_relevance(state: SimplePaperState) -> SimplePaperState:
    return {"messages": [
        SystemMessage(content=PAPER_RELEVANCE_SYSTEM_PROMPT),
        HumanMessage(content=PAPER_RELEVANCE_USER_TEMPLATE.format(
            title=state["title"], sample=state["sample"]
        )),
    ]}


async def generate_relevance(state: SimplePaperState) -> SimplePaperState:
    return {"result": await invoke_structured(PaperRelevance, state["messages"])}


def prepare_selection(state: SimplePaperState) -> SimplePaperState:
    request: PaperSelectionRequest = state["request"]
    evidence = json.dumps(
        [item.model_dump(by_alias=True) for item in request.additional_evidence],
        ensure_ascii=True,
    )
    return {"messages": [
        SystemMessage(content=PAPER_SELECTION_SYSTEM_PROMPT),
        HumanMessage(content=PAPER_SELECTION_USER_TEMPLATE.format(
            paper_title=request.paper_title,
            page_number=request.page_number,
            selected_text=request.selected_text,
            surrounding_context=request.surrounding_context,
            additional_evidence=evidence or "None",
        )),
    ]}


async def generate_selection(state: SimplePaperState) -> SimplePaperState:
    result = await invoke_structured(PaperSelectionExplanation, state["messages"])
    request: PaperSelectionRequest = state["request"]
    allowed = {request.page_number, *(item.page_number for item in request.additional_evidence)}
    result.page_citations = [page for page in result.page_citations if page in allowed]
    if request.page_number not in result.page_citations:
        result.page_citations.insert(0, request.page_number)
    return {"result": result}


def prepare_figure(state: SimplePaperState) -> SimplePaperState:
    request: PaperFigureRequest = state["request"]
    return {"messages": [
        SystemMessage(content=PAPER_FIGURE_SYSTEM_PROMPT),
        HumanMessage(content=[
            {"type": "text", "text": PAPER_FIGURE_USER_TEMPLATE.format(
                paper_title=request.paper_title,
                page_number=request.page_number,
                page_context=request.page_context,
            )},
            {"type": "image", "base64": request.image_base64, "mime_type": request.mime_type},
        ]),
    ]}


async def generate_figure(state: SimplePaperState) -> SimplePaperState:
    result = await invoke_structured(
        PaperFigureExplanation,
        state["messages"],
        llm=get_judge_llm(),
        priority=INTERACTIVE_PRIORITY,
    )
    request: PaperFigureRequest = state["request"]
    result.page_citations = [request.page_number]
    return {"result": result}


def evidence_messages(request: PaperQuestionRequest) -> list:
    evidence = json.dumps(
        [item.model_dump(by_alias=True) for item in request.evidence],
        ensure_ascii=True,
    )
    return [
        SystemMessage(content=PAPER_EVIDENCE_SYSTEM_PROMPT),
        HumanMessage(content=PAPER_EVIDENCE_USER_TEMPLATE.format(
            paper_title=request.paper_title,
            question=request.question,
            evidence=evidence,
        )),
    ]


async def grade_paper_evidence(state: SimplePaperState) -> SimplePaperState:
    request: PaperQuestionRequest = state["request"]
    if request.requested_answer_mode == "general":
        return {"grade": PaperEvidenceDecision(
            sufficient=False,
            confidence="high",
            reason="The user requested a general-knowledge answer."
        )}
    if not request.evidence:
        return {"grade": PaperEvidenceDecision(
            sufficient=False, confidence="high", reason="No relevant paper excerpts were retrieved."
        )}
    grade = await invoke_structured(
        PaperEvidenceDecision,
        evidence_messages(request),
        llm=get_judge_llm(),
    )
    return {"grade": grade}


async def answer_paper_question(state: SimplePaperState) -> SimplePaperState:
    request: PaperQuestionRequest = state["request"]
    grade = state["grade"]
    use_paper = request.requested_answer_mode == "paper" and grade.sufficient
    answer_mode = "paper" if use_paper else "general"
    if use_paper:
        label = "From the paper"
    elif request.requested_answer_mode == "general":
        label = "General knowledge"
    else:
        label = "General knowledge — this answer is not established by the uploaded paper."
    evidence = json.dumps(
        [item.model_dump(by_alias=True) for item in request.evidence]
        if use_paper else [],
        ensure_ascii=True,
    )
    messages = [
        SystemMessage(content=PAPER_ANSWER_SYSTEM_PROMPT),
        HumanMessage(content=PAPER_ANSWER_USER_TEMPLATE.format(
            paper_title=request.paper_title,
            answer_mode=answer_mode,
            label=label,
            question=request.question,
            evidence=evidence or "None",
        )),
    ]
    result = await invoke_structured(PaperQuestionAnswer, messages)
    result.answer_mode = answer_mode
    result.label = label
    if answer_mode == "general":
        result.page_citations = []
    else:
        allowed = {item.page_number for item in request.evidence}
        result.page_citations = sorted({page for page in result.page_citations if page in allowed})
    return {"result": result}


@lru_cache
def paper_relevance_workflow():
    graph = StateGraph(SimplePaperState)
    graph.add_node("prepare", prepare_relevance)
    graph.add_node("classify", generate_relevance)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "classify")
    graph.add_edge("classify", END)
    return graph.compile()


@lru_cache
def paper_selection_workflow():
    graph = StateGraph(SimplePaperState)
    graph.add_node("prepare", prepare_selection)
    graph.add_node("explain", generate_selection)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "explain")
    graph.add_edge("explain", END)
    return graph.compile()


@lru_cache
def paper_figure_workflow():
    graph = StateGraph(SimplePaperState)
    graph.add_node("prepare", prepare_figure)
    graph.add_node("explain", generate_figure)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "explain")
    graph.add_edge("explain", END)
    return graph.compile()


@lru_cache
def paper_question_workflow():
    graph = StateGraph(SimplePaperState)
    graph.add_node("grade_evidence", grade_paper_evidence)
    graph.add_node("answer", answer_paper_question)
    graph.add_edge(START, "grade_evidence")
    graph.add_edge("grade_evidence", "answer")
    graph.add_edge("answer", END)
    return graph.compile()
