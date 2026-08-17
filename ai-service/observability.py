import os
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from typing import Any, TypeVar

from langsmith import tracing_context


Result = TypeVar("Result")
_TRUE_VALUES = {"1", "true", "yes", "on"}


def _enabled(value: str | None) -> bool:
    return (value or "").strip().lower() in _TRUE_VALUES


def public_tracing_enabled() -> bool:
    """Enable public traces only when explicitly configured with an API key."""
    return _enabled(os.getenv("LANGSMITH_PUBLIC_TRACING")) and bool(
        os.getenv("LANGSMITH_API_KEY", "").strip()
    )


def _trace_details(feature: str) -> tuple[list[str], dict[str, Any]]:
    environment = os.getenv("ENVIRONMENT", "development")
    tags = ["gen-radar", "public-content", feature, environment]
    metadata = {
        "application": "gen-radar",
        "feature": feature,
        "environment": environment,
        "privacy": "public-content",
    }
    return tags, metadata


async def invoke_public_workflow(
    workflow,
    inputs: dict[str, Any],
    *,
    feature: str,
    run_name: str,
):
    """Trace a public LangGraph workflow without attaching user identifiers."""
    enabled = public_tracing_enabled()
    tags, metadata = _trace_details(feature)
    project_name = os.getenv("LANGSMITH_PROJECT", "gen-radar-development")
    with tracing_context(
        enabled=enabled,
        project_name=project_name,
        tags=tags,
        metadata=metadata,
    ):
        return await workflow.ainvoke(
            inputs,
            config={
                "run_name": run_name,
                "tags": tags,
                "metadata": metadata,
            },
        )


async def invoke_public_operation(
    operation: Callable[[], Awaitable[Result]],
    *,
    feature: str,
) -> Result:
    """Propagate selective tracing to a public LangChain operation."""
    enabled = public_tracing_enabled()
    tags, metadata = _trace_details(feature)
    project_name = os.getenv("LANGSMITH_PROJECT", "gen-radar-development")
    with tracing_context(
        enabled=enabled,
        project_name=project_name,
        tags=tags,
        metadata=metadata,
    ):
        return await operation()


@contextmanager
def private_tracing_disabled():
    """Guarantee that private PDF content is never sent to LangSmith."""
    with tracing_context(enabled=False):
        yield


async def invoke_private_workflow(workflow, inputs: dict[str, Any]):
    with private_tracing_disabled():
        return await workflow.ainvoke(inputs)
