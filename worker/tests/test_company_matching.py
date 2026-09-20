"""A question matches a company only by words that identify that company.

Spotify's domain is open.spotify.com and GitLab's is about.gitlab.com; the matcher took a domain's first label, so
"open" was Spotify and "about" was GitLab, and "Which companies open earliest?" was answered as a question about
Spotify. Words shared by many firms ("trading", "capital") identify none of them.
"""

from __future__ import annotations

import unittest

from firstseen.agent import company_identity_tokens, registrable_label
from firstseen.agent_questions import UsefulQuestionIntent


class RegistrableLabelTest(unittest.TestCase):
    def test_a_subdomain_is_not_the_company(self) -> None:
        self.assertEqual(registrable_label("open.spotify.com"), "spotify")
        self.assertEqual(registrable_label("about.gitlab.com"), "gitlab")
        self.assertEqual(registrable_label("stripe.com"), "stripe")
        self.assertEqual(registrable_label("jobs.example.co.uk"), "example")
        self.assertEqual(registrable_label("id.me"), "id")


class CompanyIdentityTokensTest(unittest.TestCase):
    def test_question_words_are_not_company_identities(self) -> None:
        question = {"which", "companies", "open", "their", "internships", "earliest", "about"}
        for name, domain in (("Spotify", "open.spotify.com"), ("GitLab", "about.gitlab.com")):
            with self.subTest(name=name):
                self.assertFalse(company_identity_tokens(name, domain) & question)

    def test_a_word_many_firms_share_identifies_none(self) -> None:
        self.assertEqual(company_identity_tokens("Hudson River Trading", "hudsonrivertrading.com"), {"hudson", "river", "hudsonrivertrading"})
        self.assertEqual(company_identity_tokens("Belvedere Trading", "belvederetrading.com"), {"belvedere", "belvederetrading"})
        self.assertEqual(company_identity_tokens("Tower Research Capital", "tower-research.com"), {"tower"})

    def test_the_company_is_still_found_by_its_name(self) -> None:
        self.assertIn("spotify", company_identity_tokens("Spotify", "open.spotify.com"))
        self.assertIn("gitlab", company_identity_tokens("GitLab", "about.gitlab.com"))


class EarliestCompaniesIntentTest(unittest.TestCase):
    def test_the_question_is_recognised_however_it_is_phrased(self) -> None:
        for question in (
            "What companies historically recruit earliest?",
            "Which companies open earliest?",
            "Which companies open their internships earliest?",
            "Which companies post new grad roles first?",
        ):
            with self.subTest(question=question):
                intent = UsefulQuestionIntent.parse(question)
                self.assertIsNotNone(intent)
                assert intent is not None
                self.assertEqual(intent.question_class, "earliest_companies")

    def test_a_question_about_one_company_is_not_a_ranking(self) -> None:
        self.assertIsNone(UsefulQuestionIntent.parse("When does Stripe open its software engineering internship?"))

    def test_asking_when_one_program_opens_and_what_to_prepare_is_about_that_program(self) -> None:
        # The watchlist-wide preparation answer ("0 prep steps for the programs you watch arles") ignored the program.
        self.assertIsNone(
            UsefulQuestionIntent.parse(
                "When will the PDT Partners Summer Systems Engineering Intern program open, and what should I prepare?"
            )
        )
        intent = UsefulQuestionIntent.parse("What should I be preparing for right now?")
        assert intent is not None
        self.assertEqual(intent.question_class, "prepare_now")


if __name__ == "__main__":
    unittest.main()
