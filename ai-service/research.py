import httpx

from llm import get_settings
from models import EvidenceItem


def search_web(queries: list[str]) -> list[EvidenceItem]:
    """Search primary sources for the Research Agent, with a small hard limit."""
    api_key = get_settings().exa_api_key
    if not api_key or not queries:
        return []

    evidence: list[EvidenceItem] = []
    seen_urls: set[str] = set()
    with httpx.Client(timeout=20) as client:
        for query in queries[:2]:
            response = client.post(
                "https://api.exa.ai/search",
                headers={"x-api-key": api_key, "Content-Type": "application/json"},
                json={
                    "query": query,
                    "type": "auto",
                    "numResults": 5,
                    "contents": {
                        "highlights": {
                            "maxCharacters": 1200,
                            "highlightsPerUrl": 2,
                        }
                    },
                },
            )
            response.raise_for_status()
            for result in response.json().get("results", []):
                url = result.get("url", "")
                if not url or url in seen_urls:
                    continue
                highlights = result.get("highlights") or []
                excerpt = "\n".join(highlights).strip() or result.get("text", "")[:1200]
                if not excerpt:
                    continue
                seen_urls.add(url)
                evidence.append(
                    EvidenceItem(
                        id=f"web-{len(evidence)}",
                        title=result.get("title") or url,
                        url=url,
                        excerpt=excerpt,
                        sourceType="web",
                    )
                )
                if len(evidence) >= 6:
                    return evidence
    return evidence
