"""`location_text` reads a source's location from the shapes real sources actually send.

Greenhouse answers `location: {"name": "New York, New York, United States"}` and JSON-LD nests the same
address keys under `jobLocation.address`. Reading only the six flat schema.org keys returned None for both,
which is why 7,803 Greenhouse observations and every generic-page observation on the rig had no location at
all. The upstream value is not kept in `raw_payload`, so recovery is re-collection, not re-parsing.
"""

import unittest

from firstseen.adapters.common import location_text


class LocationTextTests(unittest.TestCase):
    def test_a_named_office_is_read(self):
        self.assertEqual(
            location_text({"name": "New York, New York, United States"}),
            "New York, New York, United States",
        )

    def test_a_named_office_is_preferred_over_its_address(self):
        """A source that supplies `name` has already written the line it wants shown."""
        self.assertEqual(
            location_text({"name": "Zurich office", "address": {"addressLocality": "Zurich"}}),
            "Zurich office",
        )

    def test_a_nested_address_is_followed(self):
        self.assertEqual(
            location_text({"@type": "Place", "address": {"addressLocality": "Berlin", "addressCountry": "DE"}}),
            "Berlin, DE",
        )

    def test_a_job_location_wrapper_is_followed(self):
        self.assertEqual(location_text({"jobLocation": {"address": {"addressLocality": "Dublin"}}}), "Dublin")

    def test_flat_address_keys_are_not_overridden_by_a_nested_one(self):
        self.assertEqual(
            location_text({"addressLocality": "Paris", "address": {"addressLocality": "Lyon"}}),
            "Paris",
        )

    def test_a_blank_name_falls_through_to_the_address(self):
        self.assertEqual(location_text({"name": "   ", "addressLocality": "Oslo"}), "Oslo")

    def test_a_list_keeps_every_place(self):
        self.assertEqual(
            location_text([{"name": "London"}, {"address": {"addressLocality": "Leeds"}}]),
            "London \u00b7 Leeds",
        )

    def test_a_plain_string_is_kept(self):
        self.assertEqual(location_text("Remote - US"), "Remote - US")

    def test_nothing_usable_is_none(self):
        for value in ({}, {"id": 1}, "", "   ", [], None, 7):
            with self.subTest(value=value):
                self.assertIsNone(location_text(value))


if __name__ == "__main__":
    unittest.main()
