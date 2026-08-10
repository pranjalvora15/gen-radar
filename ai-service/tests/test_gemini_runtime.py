import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gemini_runtime import (
    BACKGROUND_PRIORITY,
    INTERACTIVE_PRIORITY,
    GeminiCoordinator,
    is_retryable_gemini_error,
)


class GeminiCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_generation_calls_never_overlap(self):
        coordinator = GeminiCoordinator(
            max_attempts=1,
            validation_attempts=1,
            retry_base_seconds=0,
            retry_max_seconds=0,
        )
        active = 0
        maximum_active = 0

        async def operation():
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.01)
            active -= 1
            return "ok"

        results = await asyncio.gather(
            coordinator.run(operation),
            coordinator.run(operation),
            coordinator.run(operation, priority=BACKGROUND_PRIORITY),
        )

        self.assertEqual(results, ["ok", "ok", "ok"])
        self.assertEqual(maximum_active, 1)

    async def test_waiting_chat_runs_before_next_background_job(self):
        coordinator = GeminiCoordinator(
            max_attempts=1,
            validation_attempts=1,
            retry_base_seconds=0,
            retry_max_seconds=0,
        )
        events = []
        first_media_started = asyncio.Event()
        release_first_media = asyncio.Event()

        async def first_media():
            events.append("media-1-start")
            first_media_started.set()
            await release_first_media.wait()
            events.append("media-1-end")
            return "media-1"

        async def second_media():
            events.append("media-2")
            return "media-2"

        async def chat():
            events.append("chat")
            return "chat"

        first_task = asyncio.create_task(
            coordinator.run(first_media, priority=BACKGROUND_PRIORITY)
        )
        await first_media_started.wait()
        second_task = asyncio.create_task(
            coordinator.run(second_media, priority=BACKGROUND_PRIORITY)
        )
        await asyncio.sleep(0)
        chat_task = asyncio.create_task(
            coordinator.run(chat, priority=INTERACTIVE_PRIORITY)
        )
        await asyncio.sleep(0)
        release_first_media.set()

        await asyncio.gather(first_task, second_task, chat_task)

        self.assertEqual(
            events,
            ["media-1-start", "media-1-end", "chat", "media-2"],
        )

    async def test_retryable_error_uses_bounded_retries(self):
        coordinator = GeminiCoordinator(
            max_attempts=3,
            validation_attempts=1,
            retry_base_seconds=1,
            retry_max_seconds=4,
        )
        attempts = 0

        class RateLimitError(RuntimeError):
            status_code = 429

        async def operation():
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise RateLimitError("quota temporarily exhausted")
            return "recovered"

        with patch("gemini_runtime.asyncio.sleep", new=AsyncMock()) as sleep:
            result = await coordinator.run(operation, operation_name="test")

        self.assertEqual(result, "recovered")
        self.assertEqual(attempts, 3)
        self.assertEqual(sleep.await_count, 2)

    def test_common_transient_statuses_are_retryable(self):
        for status_code in (408, 429, 500, 502, 503, 504):
            error = RuntimeError(f"provider returned {status_code}")
            error.status_code = status_code
            self.assertTrue(is_retryable_gemini_error(error))


if __name__ == "__main__":
    unittest.main()
