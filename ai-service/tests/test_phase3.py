import sys
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import (
    AnalyzeMediaRequest,
    EvidenceGrade,
    EvidenceGradeRequest,
    MediaAnalysisResponse,
    KeywordRequest,
    ScopeDecision,
    ScopeQuestionRequest,
    SuggestedQuestions,
)
from workflows import (
    download_image,
    prepare_keyword,
    validate_evidence_grade,
    validate_media,
    validate_scope,
)


class PhaseThreeTests(unittest.TestCase):
    def test_image_download_retries_through_proxy(self):
        class Response:
            def __init__(self, ok):
                self.ok = ok
                self.content = b"image-bytes" if ok else b"blocked"
                self.headers = {
                    "content-type": "image/png" if ok else "text/html"
                }

            def raise_for_status(self):
                if not self.ok:
                    raise RuntimeError("blocked")

        with patch(
            "workflows.httpx.get",
            side_effect=[Response(False), Response(True)],
        ) as get:
            content, mime_type = download_image("https://example.com/figure.png")

        self.assertEqual(content, b"image-bytes")
        self.assertEqual(mime_type, "image/png")
        self.assertTrue(get.call_args_list[1].args[0].startswith("https://wsrv.nl/"))

    def test_keyword_preparation_does_not_print_unicode_article_state(self):
        request = KeywordRequest(
            keyword="Top-K retrieval",
            title="RAG notes 📓",
            content="The retriever processes top-k documents.",
            article_explanation={"summary": "A Unicode-safe explanation ✨"},
        )
        output = StringIO()
        with redirect_stdout(output):
            state = prepare_keyword({"request": request})
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(len(state["messages"]), 2)

    def test_scope_close_cannot_be_marked_allowed(self):
        request = ScopeQuestionRequest(
            question="How does human birth happen?",
            articleTitle="RAG article",
        )
        generated = ScopeDecision(
            allowed=True,
            domain="health",
            relation="unrelated",
            confidence="high",
            action="close",
            reasonCode="outside-ai-domain",
            intent="unclear",
        )
        result = validate_scope({"request": request, "generated": generated})
        self.assertFalse(result["result"].allowed)

    def test_suggestions_require_exactly_three_unique_questions(self):
        with self.assertRaises(ValueError):
            SuggestedQuestions(questions=["What is RAG?", "What is RAG?", "Why?"])

    def test_missing_media_results_are_safely_marked_irrelevant(self):
        request = AnalyzeMediaRequest(
            articleTitle="Agent architecture",
            items=[
                {"id": 9, "mediaType": "image", "url": "https://example.com/a.png"}
            ],
        )
        generated = MediaAnalysisResponse(
            analyses=[
                {
                    "id": 10,
                    "mediaType": "image",
                    "relevant": True,
                    "description": "Wrong item",
                }
            ]
        )
        result = validate_media({"request": request, "generated": generated})
        self.assertEqual(result["result"].analyses[0].id, 9)
        self.assertFalse(result["result"].analyses[0].relevant)

    def test_research_grade_gets_a_fallback_search_query(self):
        request = EvidenceGradeRequest(
            question="How does this compare with current agent frameworks?",
            articleTitle="An agent paper",
        )
        generated = EvidenceGrade(
            sufficient=False,
            researchRequired=True,
            confidence="high",
            reasonCode="comparison-needs-research",
            missingInformation=["Current comparison"],
            searchQueries=[],
        )
        result = validate_evidence_grade(
            {"request": request, "generated": generated}
        )
        self.assertEqual(result["result"].search_queries, [request.question])


if __name__ == "__main__":
    unittest.main()
