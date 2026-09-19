import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.config import Settings
from firstseen.models import AgentRunRecord, RawJobObservation


class ModelTests(unittest.TestCase):
    def test_local_defaults_are_cost_conscious(self):
        settings = Settings(_env_file=None)
        self.assertEqual(settings.llm_model, "ollama/qwen2.5:7b")
        self.assertEqual(settings.max_source_bytes, 2_000_000)

    def test_observations_require_content_hash(self):
        with self.assertRaises(ValueError):
            RawJobObservation(
                source_id=UUID("00000000-0000-4000-8000-000000000101"),
                observed_at=datetime.now(UTC),
                content_hash="bad",
                extraction_method="http",
                raw_text="Observed role page",
            )

    def test_agent_run_requires_fingerprint(self):
        run = AgentRunRecord(
            agent_name="source_ingestion",
            purpose="Fetch configured sources",
            started_at=datetime.now(UTC),
            input_fingerprint="a" * 64,
        )
        self.assertEqual(run.status, "running")


if __name__ == "__main__":
    unittest.main()
