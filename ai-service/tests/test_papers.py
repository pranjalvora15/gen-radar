import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import (
    PaperEvidenceDecision,
    PaperQuestionAnswer,
    PaperQuestionRequest,
    PaperSelectionExplanation,
    PaperSelectionRequest,
)
from paper_workflows import paper_question_workflow, paper_selection_workflow
from paper_processing import clean_pdf_text
from embeddings import (
    _is_retryable_embedding_error,
    _paper_embedding_call,
    embed_documents_in_batches,
)


class PaperWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_paper_answer_forces_grounded_label_and_valid_pages(self):
        request = PaperQuestionRequest(
            question="What does the retriever do?",
            paperTitle="A RAG paper",
            evidence=[
                {"id": "paper-1", "pageNumber": 4, "content": "The retriever finds passages."}
            ],
        )
        generated = [
            PaperEvidenceDecision(
                sufficient=True, confidence="high", reason="The excerpt answers the question."
            ),
            PaperQuestionAnswer(
                answer="It finds relevant passages.",
                answerMode="general",
                label="incorrect",
                pageCitations=[4, 99],
            ),
        ]
        with patch(
            "paper_workflows.invoke_structured",
            new=AsyncMock(side_effect=generated),
        ):
            state = await paper_question_workflow().ainvoke({"request": request})

        self.assertEqual(state["result"].answer_mode, "paper")
        self.assertEqual(state["result"].label, "From the paper")
        self.assertEqual(state["result"].page_citations, [4])

    async def test_general_fallback_has_no_paper_citations(self):
        request = PaperQuestionRequest(
            question="How is this normally deployed?",
            paperTitle="A RAG paper",
            evidence=[],
        )
        answer = PaperQuestionAnswer(
            answer="A general deployment explanation.",
            answerMode="paper",
            label="incorrect",
            pageCitations=[1],
        )
        with patch(
            "paper_workflows.invoke_structured",
            new=AsyncMock(return_value=answer),
        ):
            state = await paper_question_workflow().ainvoke({"request": request})

        self.assertEqual(state["result"].answer_mode, "general")
        self.assertIn("not established", state["result"].label)
        self.assertEqual(state["result"].page_citations, [])

    async def test_requested_general_mode_skips_evidence_grading(self):
        request = PaperQuestionRequest(
            question="How do mixture-of-experts models normally route tokens?",
            paperTitle="A model paper",
            requestedAnswerMode="general",
            evidence=[],
        )
        answer = PaperQuestionAnswer(
            answer="A general explanation of token routing.",
            answerMode="paper",
            label="incorrect",
            pageCitations=[2],
        )
        invocation = AsyncMock(return_value=answer)
        with patch("paper_workflows.invoke_structured", new=invocation):
            state = await paper_question_workflow().ainvoke({"request": request})

        self.assertEqual(invocation.await_count, 1)
        self.assertEqual(state["result"].answer_mode, "general")
        self.assertEqual(state["result"].label, "General knowledge")
        self.assertEqual(state["result"].page_citations, [])

    async def test_selection_always_cites_selected_page(self):
        request = PaperSelectionRequest(
            paperTitle="An agent paper",
            pageNumber=7,
            selectedText="This method routes tasks.",
            surroundingContext="The router chooses one specialist for each task.",
        )
        explanation = PaperSelectionExplanation(
            simpleExplanation="It chooses a specialist.",
            whyItMatters="It reduces unnecessary work.",
            example=None,
            importantTerms=["router"],
            pageCitations=[99],
        )
        with patch(
            "paper_workflows.invoke_structured",
            new=AsyncMock(return_value=explanation),
        ):
            state = await paper_selection_workflow().ainvoke({"request": request})

        self.assertEqual(state["result"].page_citations, [7])


class PaperEmbeddingTests(unittest.TestCase):
    def test_embedding_requests_are_split_into_bounded_batches(self):
        provider = MagicMock()
        provider.embed_documents.side_effect = lambda values: [
            [float(index)] for index, _ in enumerate(values)
        ]
        texts = [f"chunk {index}" for index in range(7)]

        with (
            patch(
                "embeddings.get_settings",
                return_value=SimpleNamespace(embedding_batch_size=3),
            ),
            patch("embeddings.get_embeddings", return_value=provider),
        ):
            vectors = embed_documents_in_batches(texts)

        self.assertEqual(
            [len(call.args[0]) for call in provider.embed_documents.call_args_list],
            [3, 3, 1],
        )
        self.assertEqual(len(vectors), len(texts))

    def test_paper_embedding_retries_a_transient_quota_error(self):
        operation = MagicMock(
            side_effect=[RuntimeError("429 RESOURCE_EXHAUSTED"), [0.1, 0.2]]
        )
        settings = SimpleNamespace(
            paper_embedding_max_attempts=2,
            paper_embedding_min_interval_seconds=0,
        )

        with patch("embeddings.get_settings", return_value=settings):
            result = _paper_embedding_call(operation)

        self.assertEqual(result, [0.1, 0.2])
        self.assertEqual(operation.call_count, 2)

    def test_embedding_disconnects_and_timeouts_are_retryable(self):
        self.assertTrue(_is_retryable_embedding_error(
            RuntimeError("Server disconnected without sending a response")
        ))
        self.assertTrue(_is_retryable_embedding_error(
            RuntimeError("request timed out")
        ))
        self.assertFalse(_is_retryable_embedding_error(
            RuntimeError("400 invalid embedding input")
        ))

    def test_pdf_text_removes_postgres_incompatible_nul_bytes(self):
        self.assertEqual(clean_pdf_text("Deep\x00Seek\nV3"), "DeepSeek\nV3")


if __name__ == "__main__":
    unittest.main()
