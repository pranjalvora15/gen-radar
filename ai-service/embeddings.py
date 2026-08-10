from functools import lru_cache
from threading import Lock
import time

from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from llm import get_settings
from models import (
    EmbedDocumentsRequest,
    EmbedDocumentsResponse,
    EmbeddedChunk,
    EmbedQueryResponse,
    EmbedPaperPagesRequest,
    EmbedPaperPagesResponse,
    EmbeddedPaperChunk,
)


_paper_embedding_lock = Lock()
_paper_last_request_at = 0.0


def _is_retryable_embedding_error(error: Exception) -> bool:
    message = str(error).upper()
    return any(marker in message for marker in (
        "408",
        "429",
        "502",
        "503",
        "RESOURCE_EXHAUSTED",
        "UNAVAILABLE",
        "TIMEOUT",
        "TIMED OUT",
        "SERVER DISCONNECTED",
        "CONNECTION RESET",
        "REMOTE PROTOCOL",
    ))


@lru_cache
def get_embeddings() -> GoogleGenerativeAIEmbeddings:
    settings = get_settings()
    return GoogleGenerativeAIEmbeddings(
        model=settings.embedding_model,
        api_key=settings.google_api_key,
        output_dimensionality=settings.embedding_dimensions,
        request_options={"timeout": 45},
    )


@lru_cache
def get_paper_embeddings() -> GoogleGenerativeAIEmbeddings:
    settings = get_settings()
    return GoogleGenerativeAIEmbeddings(
        model=settings.paper_embedding_model,
        api_key=settings.google_api_key,
        output_dimensionality=settings.embedding_dimensions,
        request_options={"timeout": 45},
    )


@lru_cache
def get_text_splitter() -> RecursiveCharacterTextSplitter:
    settings = get_settings()
    return RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
    )


def embed_documents_in_batches(
    texts: list[str],
    provider: GoogleGenerativeAIEmbeddings | None = None,
) -> list[list[float]]:
    """Embed bounded batches so a large paper is never one provider request."""
    if not texts:
        return []
    batch_size = max(1, get_settings().embedding_batch_size)
    embedding_provider = provider or get_embeddings()
    vectors: list[list[float]] = []
    for index in range(0, len(texts), batch_size):
        vectors.extend(
            embedding_provider.embed_documents(texts[index:index + batch_size])
        )
    return vectors


def _paper_embedding_call(operation):
    """Serialize and pace PDF embeddings for low-RPM/TPM API quotas."""
    global _paper_last_request_at
    settings = get_settings()
    attempts = max(1, settings.paper_embedding_max_attempts)
    interval = max(0.0, settings.paper_embedding_min_interval_seconds)
    with _paper_embedding_lock:
        for attempt in range(attempts):
            remaining = interval - (time.monotonic() - _paper_last_request_at)
            if remaining > 0:
                time.sleep(remaining)
            try:
                return operation()
            except Exception as error:
                if not _is_retryable_embedding_error(error) or attempt + 1 >= attempts:
                    raise
            finally:
                _paper_last_request_at = time.monotonic()
    raise RuntimeError("Paper embedding retry loop ended unexpectedly")


def embed_paper_documents_in_batches(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    settings = get_settings()
    batch_size = max(1, settings.paper_embedding_batch_size)
    provider = get_paper_embeddings()
    vectors: list[list[float]] = []
    for index in range(0, len(texts), batch_size):
        batch = texts[index:index + batch_size]
        vectors.extend(
            _paper_embedding_call(lambda values=batch: provider.embed_documents(values))
        )
    return vectors


def embed_document(request: EmbedDocumentsRequest) -> EmbedDocumentsResponse:
    settings = get_settings()
    chunks = [
        chunk.strip()
        for chunk in get_text_splitter().split_text(request.content)
        if chunk.strip()
    ]
    prepared = [
        f"title: {request.title} | text: {chunk}"
        for chunk in chunks
    ]
    vectors = embed_documents_in_batches(prepared)
    return EmbedDocumentsResponse(
        model=settings.embedding_model,
        dimensions=settings.embedding_dimensions,
        chunks=[
            EmbeddedChunk(index=index, content=chunk, embedding=vector)
            for index, (chunk, vector) in enumerate(zip(chunks, vectors))
        ],
    )


def embed_question(query: str) -> EmbedQueryResponse:
    settings = get_settings()
    vector = get_embeddings().embed_query(
        f"task: question answering | query: {query.strip()}"
    )
    return EmbedQueryResponse(
        model=settings.embedding_model,
        dimensions=settings.embedding_dimensions,
        embedding=vector,
    )


def embed_paper_question(query: str) -> EmbedQueryResponse:
    settings = get_settings()
    prepared = f"task: paper question answering | query: {query.strip()}"
    provider = get_paper_embeddings()
    vector = _paper_embedding_call(
        lambda: provider.embed_query(prepared)
    )
    return EmbedQueryResponse(
        model=settings.paper_embedding_model,
        dimensions=settings.embedding_dimensions,
        embedding=vector,
    )


def embed_paper_pages(request: EmbedPaperPagesRequest) -> EmbedPaperPagesResponse:
    settings = get_settings()
    chunks: list[tuple[int, int, str]] = []
    for page in request.pages:
        page_chunks = [
            value.strip()
            for value in get_text_splitter().split_text(page.text)
            if value.strip()
        ]
        chunks.extend(
            (page.page_number, index, content)
            for index, content in enumerate(page_chunks)
        )
    if not chunks:
        return EmbedPaperPagesResponse(
            model=settings.paper_embedding_model,
            dimensions=settings.embedding_dimensions,
            chunks=[],
        )
    prepared = [
        f"title: {request.title} | page: {page_number} | text: {content}"
        for page_number, _, content in chunks
    ]
    vectors = embed_paper_documents_in_batches(prepared)
    return EmbedPaperPagesResponse(
        model=settings.paper_embedding_model,
        dimensions=settings.embedding_dimensions,
        chunks=[
            EmbeddedPaperChunk(
                pageNumber=page_number,
                chunkIndex=chunk_index,
                content=content,
                embedding=vector,
            )
            for (page_number, chunk_index, content), vector in zip(chunks, vectors)
        ],
    )
