"""Registering an ATS board the company's own pages do not link, and what the ATS has to say first.

Greenhouse publishes a board name, so the name has to name the company. Ashby and Lever publish none, so the board's
own postings have to name it, several of them. That rule is what refuses a tenant that is somebody else's board, and
these tests pin the two ways it could be fooled: a posting that names the company only inside its own board URL (every
posting carries one, so counting it would accept any tenant spelled like the company), and a board whose postings name
a different company.

They also pin the two things an oversized board needs: it is read whole up to the per-source ceiling, and it records
its own read limit on the source instead of the global cap moving.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen import cli
from firstseen.adapters.base import SOURCE_BYTES_CEILING, FetchedDocument
from firstseen.discovery import BOARD_POSTINGS_NAMING_COMPANY, postings_naming_company

COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")


def ashby_board(jobs: list[dict[str, Any]]) -> str:
    return json.dumps({"jobs": jobs, "apiVersion": "1"})


def posting(title: str, description: str, tenant: str = "acme") -> dict[str, Any]:
    return {
        "id": "8152eaf6-012b-4154-95e2-7d6c52faba93",
        "title": title,
        "descriptionPlain": description,
        "location": "San Francisco",
        "jobUrl": f"https://jobs.ashbyhq.com/{tenant}/8152eaf6",
        "applyUrl": f"https://jobs.ashbyhq.com/{tenant}/8152eaf6/application",
    }


class PostingsNamingCompanyTests(unittest.TestCase):
    def test_a_posting_that_names_the_company_only_in_its_own_url_does_not_count(self):
        # Every Ashby posting carries jobs.ashbyhq.com/<tenant>. If that counted, any tenant spelled like the company
        # would confirm itself, which is the whole thing this check exists to prevent.
        board = ashby_board([posting("Software Engineer", "Build things.", tenant="acme") for _ in range(5)])
        naming, read, _ = postings_naming_company("ashby", board, "Acme", "acme.com")
        self.assertEqual((naming, read), (0, 5))

    def test_postings_that_say_the_company_name_count(self):
        board = ashby_board(
            [posting("Software Engineer", "At Acme we build things."), posting("Designer", "Acme is hiring."),
             posting("SRE", "Join Acme."), posting("Analyst", "Unrelated copy.")]
        )
        naming, read, quote = postings_naming_company("ashby", board, "Acme", "acme.com")
        self.assertEqual((naming, read), (3, 4))
        self.assertEqual(quote, "Software Engineer")

    def test_a_board_whose_postings_name_another_company_is_not_confirmed(self):
        board = ashby_board([posting("Engineer", "Everpure is hiring across Japan.") for _ in range(9)])
        naming, _, _ = postings_naming_company("ashby", board, "Pure Storage", "purestorage.com")
        self.assertEqual(naming, 0)

    def test_the_domain_label_also_names_the_company(self):
        board = ashby_board([posting("Engineer", "Read more at our handbook: physicalintelligence is remote-first.")] * 4)
        naming, _, _ = postings_naming_company("ashby", board, "Physical Intelligence", "physicalintelligence.company")
        self.assertEqual(naming, 4)

    def test_lever_boards_are_read_as_a_list(self):
        board = json.dumps([{"text": "Autonomy Engineer", "descriptionPlain": "Zoox is hiring.",
                             "hostedUrl": "https://jobs.lever.co/zoox/1"}] * 3)
        naming, read, quote = postings_naming_company("lever", board, "Zoox", "zoox.com")
        self.assertEqual((naming, read), (3, 3))
        self.assertEqual(quote, "Autonomy Engineer")

    def test_a_response_that_is_not_a_board_reads_as_no_postings(self):
        for text in ("not json", "{}", "[]", json.dumps({"jobs": "nope"})):
            naming, read, _ = postings_naming_company("ashby", text, "Acme", "acme.com")
            self.assertEqual((naming, read), (0, 0), text)


class FakeRepository:
    def __init__(self):
        self.saved: list[Any] = []

    def company_by_domain(self, domain):
        return {"id": str(COMPANY_ID), "name": "Acme", "domain": domain}

    def company_hold(self, company_id):
        return None

    def start_agent_run(self, **kwargs):
        return UUID("00000000-0000-4000-8000-0000000000aa")

    def record_tool_call(self, *args, **kwargs):
        self.calls = getattr(self, "calls", []) + [kwargs]

    def finish_agent_run(self, *args, **kwargs):
        self.finished = kwargs

    def save_discovered_sources(self, company_id, company_name, sources):
        self.saved.extend(sources)
        return [source.as_source_config(company_name) for source in sources]


class FakeTransport:
    def __init__(self, body: bytes, status: int = 200):
        self.body, self.status = body, status
        self.max_bytes: int | None = None

    def __call__(self, settings):
        return self

    def get(self, url, *, accept="*/*", max_bytes=None):
        self.max_bytes = max_bytes
        return FetchedDocument(url=url, status=self.status, content_type="application/json", body=self.body)


class AshbyRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.repository = FakeRepository()
        self._from_settings = cli.IntelligenceRepository.from_settings
        self._transport = cli.UrlLibTransport
        cli.IntelligenceRepository.from_settings = staticmethod(lambda settings: self.repository)  # type: ignore[method-assign]

    def tearDown(self):
        cli.IntelligenceRepository.from_settings = self._from_settings  # type: ignore[method-assign]
        cli.UrlLibTransport = self._transport

    def register(self, body: bytes, adapter: str = "ashby") -> int:
        cli.UrlLibTransport = FakeTransport(body)  # type: ignore[assignment]
        return cli.run_ats_board_registration("acme.com", "acme", adapter)

    def test_a_board_too_few_of_whose_postings_name_the_company_is_refused(self):
        board = ashby_board([posting("Engineer", "At Acme we build."), posting("Designer", "Unrelated.")])
        self.assertEqual(self.register(board.encode()), 1)
        self.assertEqual(self.repository.saved, [])

    def test_a_confirmed_board_is_saved_with_the_count_as_its_evidence(self):
        jobs = [posting("Engineer", f"At Acme we build, number {index}.") for index in range(BOARD_POSTINGS_NAMING_COMPANY)]
        self.assertEqual(self.register(ashby_board(jobs).encode()), 0)
        self.assertEqual(len(self.repository.saved), 1)
        source = self.repository.saved[0]
        self.assertEqual((source.adapter, source.external_key), ("ashby", "acme"))
        self.assertEqual(str(source.url), "https://jobs.ashbyhq.com/acme")
        quote = source.evidence[0].quote
        self.assertIn(f"{BOARD_POSTINGS_NAMING_COMPANY} of the {BOARD_POSTINGS_NAMING_COMPANY} postings", quote)
        self.assertEqual(source.evidence[0].metadata["postings_naming_company"], BOARD_POSTINGS_NAMING_COMPANY)
        self.assertEqual(source.options, {}, "a board inside the cap needs no read limit of its own")

    def test_the_board_is_read_up_to_the_per_source_ceiling(self):
        jobs = [posting("Engineer", "At Acme we build.") for _ in range(BOARD_POSTINGS_NAMING_COMPANY)]
        self.register(ashby_board(jobs).encode())
        self.assertEqual(cli.UrlLibTransport.max_bytes, SOURCE_BYTES_CEILING)  # type: ignore[attr-defined]

    def test_a_board_over_the_cap_records_its_own_read_limit(self):
        padding = "At Acme we build. " + "x" * 4_000_000
        jobs = [posting("Engineer", padding) for _ in range(BOARD_POSTINGS_NAMING_COMPANY)]
        body = ashby_board(jobs).encode()
        self.assertGreater(len(body), 10_000_000, "the fixture has to exceed MAX_SOURCE_BYTES to test the raise")
        self.assertEqual(self.register(body), 0)
        limit = self.repository.saved[0].options["max_source_bytes"]
        self.assertGreater(limit, len(body), "the limit leaves room for the postings the board gains between runs")
        self.assertLessEqual(limit, SOURCE_BYTES_CEILING)

    def test_an_unsupported_adapter_is_refused_before_any_request(self):
        self.assertEqual(self.register(b"{}", adapter="workday"), 1)
        self.assertEqual(self.repository.saved, [])


if __name__ == "__main__":
    unittest.main()
