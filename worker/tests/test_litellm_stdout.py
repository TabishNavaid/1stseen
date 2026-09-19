"""A failed model call writes nothing to stdout.

Every CLI command prints its JSON summary on stdout, and the collection workflows save it as their artifact. LiteLLM
printed a help banner to stdout on every failed call, so with no model server reachable (the local rig's collection
runs, and any workflow without a model) 405 banners preceded the current-jobs summary and it no longer parsed.
"""

from __future__ import annotations

import contextlib
import io
import os
import unittest
from unittest import mock

from firstseen.providers import LiteLLMBackend, ModelRoute


class LiteLLMStdoutTest(unittest.TestCase):
    def test_an_unreachable_model_fails_without_printing(self) -> None:
        # Importing litellm loads the working directory's .env into os.environ; keep that out of every other test.
        with mock.patch.dict(os.environ):
            from litellm.exceptions import APIConnectionError

            self._call_unreachable_model(APIConnectionError)

    def _call_unreachable_model(self, expected: type[Exception]) -> None:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), self.assertRaises(expected):
            LiteLLMBackend().complete(
                # Port 9 (discard) is closed locally: the call fails at once, as it does with no model server.
                ModelRoute(provider="ollama", model="ollama/qwen2.5:7b", api_base="http://127.0.0.1:9"),
                messages=[{"role": "user", "content": "ping"}],
                response_format=None,
                timeout_seconds=2,
            )
        self.assertEqual(stdout.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
