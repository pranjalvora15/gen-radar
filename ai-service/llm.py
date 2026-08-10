from functools import lru_cache
from pathlib import Path

from langchain_google_genai import ChatGoogleGenerativeAI
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).with_name(".env")
SERVER_ENV_FILE = Path(__file__).resolve().parents[1] / "server" / ".env"


class Settings(BaseSettings):
    google_api_key: str
    exa_api_key: str | None = None
    gemini_model: str = "gemini-3.5-flash-lite"
    gemini_judge_model: str = "gemini-3.5-flash"
    embedding_model: str = "gemini-embedding-2"
    paper_embedding_model: str = "gemini-embedding-001"
    embedding_dimensions: int = 768
    embedding_batch_size: int = 100
    paper_embedding_batch_size: int = 10
    paper_embedding_min_interval_seconds: float = 21
    paper_embedding_max_attempts: int = 4
    chunk_size: int = 3_000
    chunk_overlap: int = 300

    model_config = SettingsConfigDict(
        env_file=(SERVER_ENV_FILE, ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_llm() -> ChatGoogleGenerativeAI:
    settings = get_settings()
    return ChatGoogleGenerativeAI(
        model=settings.gemini_model,
        api_key=settings.google_api_key,
        temperature=None,
        top_p=None,
        top_k=None,
        # Retries are coordinated centrally so chat and media calls cannot
        # create overlapping provider retry storms.
        retries=0,
        request_timeout=45,
        thinking_level="minimal",
    )


@lru_cache
def get_judge_llm() -> ChatGoogleGenerativeAI:
    settings = get_settings()
    return ChatGoogleGenerativeAI(
        model=settings.gemini_judge_model,
        api_key=settings.google_api_key,
        temperature=None,
        top_p=None,
        top_k=None,
        retries=0,
        request_timeout=45,
        thinking_level="low",
    )
