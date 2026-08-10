import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import ScopeQuestionRequest
from workflows import (
    parse_json_object,
    scope_question_workflow,
    structured_payload_from_raw,
)


class StructuredOutputTests(unittest.TestCase):
    def test_parses_json_from_markdown_code_fence(self):
        result = parse_json_object(
            '```json\n{"keyword": "multimodal fine-tuning"}\n```'
        )
        self.assertEqual(result, {"keyword": "multimodal fine-tuning"})

    def test_rejects_content_without_json_object(self):
        with self.assertRaises(ValueError):
            parse_json_object("No structured response")

    def test_extracts_structured_tool_call_arguments(self):
        class RawMessage:
            tool_calls = [{"args": {"assessments": []}}]
            additional_kwargs = {}
            content = ""

        self.assertEqual(
            structured_payload_from_raw(RawMessage()),
            {"assessments": []},
        )


class AsyncWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_langgraph_generation_nodes_use_async_model_calls(self):
        class FakeStructuredChain:
            async def ainvoke(self, _messages):
                return {
                    "parsed": {
                        "allowed": True,
                        "domain": "ai",
                        "relation": "ai",
                        "confidence": "high",
                        "action": "continue",
                        "reasonCode": "ai-domain",
                        "intent": "document",
                    }
                }

        class FakeLlm:
            def with_structured_output(self, *_args, **_kwargs):
                return FakeStructuredChain()

        request = ScopeQuestionRequest(
            question="How does this RAG retriever work?",
            articleTitle="RAG architecture",
        )
        with patch("workflows.get_llm", return_value=FakeLlm()):
            result = await scope_question_workflow().ainvoke(
                {"request": request}
            )

        self.assertTrue(result["result"].allowed)


if __name__ == "__main__":
    unittest.main()
