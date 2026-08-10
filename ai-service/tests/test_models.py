import sys
import unittest
from pathlib import Path

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import (
    ArticleExplanation,
    CandidateRankingResponse,
    FeedSummaryResponse,
    KeywordExplanation,
)


class ModelValidationTests(unittest.TestCase):
    def test_valid_article_explanation(self):
        result = ArticleExplanation.model_validate(
            {
                "category": "rag",
                "summary": "A factual summary.",
                "simpleExplanation": "A plain explanation.",
                "problemSolved": "It grounds answers in retrieved evidence.",
                "tradeOffs": ["Retrieval adds latency."],
                "keyPoints": ["One"],
                "limitations": [],
                "keywords": [
                    "RAG",
                    "Retrieval",
                    "Generation",
                    "Context",
                    "Reranking",
                ],
            }
        )
        self.assertEqual(result.category, "rag")

    def test_rejects_unknown_category(self):
        with self.assertRaises(ValidationError):
            ArticleExplanation.model_validate(
                {
                    "category": "tools",
                    "summary": "Summary",
                    "simpleExplanation": "Explanation",
                    "problemSolved": "Problem",
                    "tradeOffs": [],
                    "keyPoints": ["One"],
                    "limitations": [],
                    "keywords": ["One", "Two", "Three", "Four", "Five"],
                }
            )

    def test_rejects_duplicate_keywords(self):
        with self.assertRaises(ValidationError):
            ArticleExplanation.model_validate(
                {
                    "category": "models",
                    "summary": "Summary",
                    "simpleExplanation": "Explanation",
                    "problemSolved": "Problem",
                    "tradeOffs": [],
                    "keyPoints": ["One"],
                    "limitations": [],
                    "keywords": ["RAG", "rag", "Three", "Four", "Five"],
                }
            )

    def test_rejects_oversized_keyword_arrays(self):
        with self.assertRaises(ValidationError):
            KeywordExplanation.model_validate(
                {
                    "keyword": "RAG",
                    "simpleDefinition": "Definition",
                    "relationToArticle": "Relation",
                    "example": "Example",
                    "relatedConcepts": ["1", "2", "3", "4", "5"],
                    "prerequisites": [],
                }
            )

    def test_valid_candidate_ranking(self):
        result = CandidateRankingResponse.model_validate(
            {
                "assessments": [
                    {
                        "id": "candidate-1",
                        "decision": "accept",
                        "contentType": "experiment",
                        "learningValue": 5,
                        "technicalDepth": 5,
                        "novelty": 4,
                        "evidence": 4,
                        "marketingPenalty": 0,
                        "reason": "Contains a concrete ablation.",
                    }
                ]
            }
        )
        self.assertEqual(result.assessments[0].content_type, "experiment")

    def test_candidate_ranking_supplies_missing_reason(self):
        result = CandidateRankingResponse.model_validate(
            {
                "assessments": [
                    {
                        "id": "candidate-1",
                        "decision": "accept",
                        "contentType": "research",
                        "learningValue": 5,
                        "technicalDepth": 5,
                        "novelty": 4,
                        "evidence": 5,
                        "marketingPenalty": 0,
                    }
                ]
            }
        )
        self.assertTrue(result.assessments[0].reason)

    def test_valid_feed_summary_response(self):
        summary = " ".join([
            "The article introduces a technical retrieval method.",
            "It addresses unnecessary context sent to a language model.",
            "Candidates are evaluated sequentially.",
            "The loop stops after sufficient evidence is found.",
            "This can reduce token usage.",
            "The supplied excerpt reports an implementation example.",
            "The approach remains dependent on reliable sufficiency checks.",
        ])
        result = FeedSummaryResponse.model_validate({
            "summaries": [{"id": "candidate-1", "summary": summary}]
        })
        self.assertEqual(result.summaries[0].id, "candidate-1")

    def test_feed_summary_requires_seven_or_eight_sentences(self):
        with self.assertRaises(ValidationError):
            FeedSummaryResponse.model_validate(
                {
                    "summaries": [
                        {
                            "id": "candidate-1",
                            "summary": "This summary is intentionally long enough to pass the character requirement but has only one sentence because it keeps adding explanatory words without adding any other terminal punctuation at all for this validation test.",
                        }
                    ]
                }
            )


if __name__ == "__main__":
    unittest.main()
