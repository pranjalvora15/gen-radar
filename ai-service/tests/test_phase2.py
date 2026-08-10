import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from embeddings import embed_document, embed_question
from models import (
    AnswerQuestionRequest,
    AnswerResult,
    EmbedDocumentsRequest,
    EvidenceItem,
    QuestionRoute,
)
from workflows import validate_answer


class FakeEmbeddings:
    def embed_documents(self, documents):
        return [[float(index), 0.5] for index, _ in enumerate(documents)]

    def embed_query(self, query):
        return [0.25, 0.75]


class PhaseTwoTests(unittest.TestCase):
    def test_route_rejects_unknown_paths(self):
        with self.assertRaises(ValueError):
            QuestionRoute(
                route="invented_route",
                reason="Not allowed",
                confidence="high",
            )

    @patch("embeddings.get_embeddings", return_value=FakeEmbeddings())
    def test_document_embedding_splits_and_returns_vectors(self, _mock):
        request = EmbedDocumentsRequest(
            title="RAG",
            content=("Retrieval sends useful evidence to a model. " * 200),
        )
        result = embed_document(request)
        self.assertGreater(len(result.chunks), 1)
        self.assertEqual(result.chunks[0].embedding, [0.0, 0.5])

    @patch("embeddings.get_embeddings", return_value=FakeEmbeddings())
    def test_query_embedding_returns_provider_vector(self, _mock):
        result = embed_question("What is retrieval?")
        self.assertEqual(result.embedding, [0.25, 0.75])

    def test_general_answers_cannot_claim_evidence_ids(self):
        request = AnswerQuestionRequest(
            question="What is an embedding?",
            articleTitle="Article",
            route="general",
            evidence=[
                EvidenceItem(
                    id="article-1",
                    title="Article",
                    url="https://example.com",
                    excerpt="Some article text",
                    sourceType="article",
                )
            ],
        )
        generated = AnswerResult(
            answer="A general explanation.",
            answerMode="article",
            usedEvidenceIds=["article-1"],
        )
        state = validate_answer({"request": request, "generated": generated})
        self.assertEqual(state["result"].answer_mode, "general")
        self.assertEqual(state["result"].used_evidence_ids, [])


if __name__ == "__main__":
    unittest.main()
