import asyncio
import logging
import os
import random
from contextlib import asynccontextmanager
from typing import Awaitable, Callable, TypeVar


logger = logging.getLogger(__name__)

INTERACTIVE_PRIORITY = "interactive"
BACKGROUND_PRIORITY = "background"

T = TypeVar("T")


def _positive_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _positive_float(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.getenv(name, str(default))))
    except ValueError:
        return default


def is_retryable_gemini_error(error: Exception) -> bool:
    retryable_codes = {408, 429, 500, 502, 503, 504}
    retryable_names = {
        "DeadlineExceeded",
        "InternalServerError",
        "ResourceExhausted",
        "ServiceUnavailable",
        "TooManyRequests",
    }
    retryable_text = (
        "429",
        "500",
        "502",
        "503",
        "504",
        "deadline exceeded",
        "rate limit",
        "resource exhausted",
        "service unavailable",
        "temporarily unavailable",
        "timeout",
        "timed out",
    )

    current: BaseException | None = error
    while current is not None:
        if current.__class__.__name__ in retryable_names:
            return True
        for attribute in ("status_code", "status", "code"):
            value = getattr(current, attribute, None)
            if callable(value):
                try:
                    value = value()
                except TypeError:
                    value = None
            numeric_value = getattr(value, "value", value)
            if numeric_value in retryable_codes:
                return True
        if any(marker in str(current).lower() for marker in retryable_text):
            return True
        current = current.__cause__ or current.__context__
    return False


class GeminiCoordinator:
    """Serializes Gemini generation and gives waiting chat work precedence."""

    def __init__(
        self,
        *,
        max_attempts: int = 3,
        validation_attempts: int = 2,
        retry_base_seconds: float = 1.0,
        retry_max_seconds: float = 4.0,
    ) -> None:
        self.max_attempts = max(1, max_attempts)
        self.validation_attempts = max(1, validation_attempts)
        self.retry_base_seconds = max(0.0, retry_base_seconds)
        self.retry_max_seconds = max(0.0, retry_max_seconds)
        self._state_lock = asyncio.Lock()
        self._condition = asyncio.Condition(self._state_lock)
        self._active = False
        self._interactive_waiting = 0

    @asynccontextmanager
    async def slot(self, priority: str = INTERACTIVE_PRIORITY):
        interactive = priority != BACKGROUND_PRIORITY
        registered = False
        acquired = False

        async with self._condition:
            if interactive:
                self._interactive_waiting += 1
                registered = True
            try:
                await self._condition.wait_for(
                    lambda: not self._active
                    and (interactive or self._interactive_waiting == 0)
                )
                if registered:
                    self._interactive_waiting -= 1
                    registered = False
                self._active = True
                acquired = True
            except BaseException:
                if registered:
                    self._interactive_waiting -= 1
                    self._condition.notify_all()
                raise

        try:
            yield
        finally:
            if acquired:
                async with self._condition:
                    self._active = False
                    self._condition.notify_all()

    async def run(
        self,
        operation: Callable[[], Awaitable[T]],
        *,
        priority: str = INTERACTIVE_PRIORITY,
        operation_name: str = "gemini_generation",
    ) -> T:
        attempt = 0
        while True:
            attempt += 1
            try:
                async with self.slot(priority):
                    return await operation()
            except Exception as error:
                retryable = is_retryable_gemini_error(error)
                attempt_limit = (
                    self.max_attempts if retryable else self.validation_attempts
                )
                if attempt >= attempt_limit:
                    logger.exception(
                        "Gemini operation failed after %s attempt(s)",
                        attempt,
                        extra={
                            "operation": operation_name,
                            "priority": priority,
                            "retryable": retryable,
                        },
                    )
                    raise

                base_delay = min(
                    self.retry_max_seconds,
                    self.retry_base_seconds * (2 ** (attempt - 1)),
                )
                delay = base_delay + random.uniform(0, base_delay * 0.25)
                logger.warning(
                    "Gemini operation failed; retrying in %.2f seconds",
                    delay,
                    extra={
                        "operation": operation_name,
                        "priority": priority,
                        "attempt": attempt,
                        "retryable": retryable,
                        "error_type": error.__class__.__name__,
                    },
                )
                # Sleep after releasing the shared slot so interactive chat can
                # run while a lower-priority background operation is backing off.
                await asyncio.sleep(delay)


gemini_coordinator = GeminiCoordinator(
    max_attempts=_positive_int("GEMINI_MAX_ATTEMPTS", 3),
    validation_attempts=_positive_int("GEMINI_VALIDATION_ATTEMPTS", 2),
    retry_base_seconds=_positive_float("GEMINI_RETRY_BASE_SECONDS", 1.0),
    retry_max_seconds=_positive_float("GEMINI_RETRY_MAX_SECONDS", 4.0),
)
