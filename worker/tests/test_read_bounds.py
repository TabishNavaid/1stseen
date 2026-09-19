"""Every PostgREST read in the worker is paged or provably bounded.

PostgREST returns at most `db.max_rows` (1000) rows per response and reports no error when it truncates. This has
bitten three times: evidence loading dropped 2,468 observations, the role page listed 60 of 114 contributions, and the
agent ranked companies from the first 1,000 of 9,383 opening events. So a read is allowed in exactly two shapes:

- paged to exhaustion by `repository.fetch_all_rows`, over the relation's unique key; or
- annotated `# bounded: <why>` on the line above the statement (or inside it), naming a hard cap: a unique key, a
  single row, a deliberate top-N the caller presents as such, or a function whose SQL caps its rows.

This test walks the source with `ast` and fails on any read in neither shape, so a new unbounded read cannot land
green. It checks itself against small snippets first, so it cannot pass by finding nothing.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src" / "firstseen"
WRITES = {"insert", "update", "upsert", "delete"}
MIN_REASON = 15


def _chain_names(node: ast.AST) -> list[str]:
    """Attribute names along a method chain, outermost first: a.table(x).select(y).eq(z) -> [eq, select, table]."""
    names: list[str] = []
    while True:
        if isinstance(node, ast.Call):
            node = node.func
        elif isinstance(node, ast.Attribute):
            names.append(node.attr)
            node = node.value
        else:
            return names


def _is_read(call: ast.Call) -> bool:
    """A chain that reaches PostgREST through .table(...) or .rpc(...) and writes nothing."""
    names = _chain_names(call)
    if "rpc" in names:
        return True
    return "table" in names and not (WRITES & set(names))


def _outermost_chains(tree: ast.AST) -> list[ast.Call]:
    """The outermost call of every method chain, so one read is reported once."""
    inner: set[int] = set()
    calls: list[ast.Call] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            calls.append(node)
            child: ast.AST = node.func
            while isinstance(child, (ast.Attribute, ast.Call)):
                if isinstance(child, ast.Call):
                    inner.add(id(child))
                    child = child.func
                else:
                    child = child.value
    return [call for call in calls if id(call) not in inner]


def unbounded_reads(source: str, filename: str = "<snippet>") -> list[str]:
    """Every read in `source` that is neither paged by fetch_all_rows nor annotated with a bound."""
    tree = ast.parse(source)
    lines = source.splitlines()
    parents: dict[int, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node

    # Builders passed to fetch_all_rows by name (`def roles(): ...` then `fetch_all_rows(roles, key=...)`).
    paged_builders: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "fetch_all_rows":
            for argument in node.args:
                if isinstance(argument, ast.Name):
                    paged_builders.add(argument.id)

    def paged(node: ast.AST) -> bool:
        current: ast.AST | None = node
        while current is not None:
            if isinstance(current, ast.Call) and getattr(current.func, "id", None) == "fetch_all_rows":
                return True
            if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)) and current.name in paged_builders:
                return True
            current = parents.get(id(current))
        return False

    def statement(node: ast.AST) -> ast.stmt:
        current: ast.AST = node
        while not isinstance(current, ast.stmt):
            current = parents[id(current)]
        return current

    def annotated(stmt: ast.stmt) -> bool:
        candidates = [lines[stmt.lineno - 2]] if stmt.lineno >= 2 else []
        candidates += lines[stmt.lineno - 1 : (stmt.end_lineno or stmt.lineno)]
        for line in candidates:
            marker = line.find("# bounded:")
            if marker >= 0 and len(line[marker + len("# bounded:") :].strip()) >= MIN_REASON:
                return True
        return False

    found: list[str] = []
    for call in _outermost_chains(tree):
        if not _is_read(call) or paged(call):
            continue
        stmt = statement(call)
        if not annotated(stmt):
            found.append(f"{filename}:{call.lineno}: {lines[call.lineno - 1].strip()[:100]}")
    return found


class ReadBoundsCheckerTest(unittest.TestCase):
    """The checker itself: it must flag an unbounded read and pass the two allowed shapes."""

    def test_an_unannotated_read_is_flagged(self) -> None:
        source = 'rows = client.table("forecasts").select("*").execute().data\n'
        self.assertEqual(len(unbounded_reads(source)), 1)

    def test_an_unannotated_rpc_is_flagged(self) -> None:
        source = 'rows = client.rpc("forecast_basis", {"p_role_ids": ids}).execute().data\n'
        self.assertEqual(len(unbounded_reads(source)), 1)

    def test_a_reason_too_short_to_name_a_cap_is_flagged(self) -> None:
        source = '# bounded: small\nrows = client.table("forecasts").select("*").execute().data\n'
        self.assertEqual(len(unbounded_reads(source)), 1)

    def test_a_paged_read_passes(self) -> None:
        source = 'rows = fetch_all_rows(lambda: client.table("forecasts").select("*"), key="id")\n'
        self.assertEqual(unbounded_reads(source), [])

    def test_a_named_builder_passed_to_the_pager_passes(self) -> None:
        source = (
            "def roles():\n"
            '    return client.table("canonical_roles").select("id")\n'
            'rows = fetch_all_rows(roles, key="id")\n'
        )
        self.assertEqual(unbounded_reads(source), [])

    def test_an_annotated_single_row_read_passes(self) -> None:
        source = (
            "# bounded: one row, selected by the primary key\n"
            'row = client.table("forecasts").select("*").eq("id", x).limit(1).execute().data\n'
        )
        self.assertEqual(unbounded_reads(source), [])

    def test_a_write_is_not_a_read(self) -> None:
        source = 'client.table("forecasts").insert({"id": x}).execute()\n'
        self.assertEqual(unbounded_reads(source), [])


class RowsInKeysTest(unittest.TestCase):
    def test_every_table_read_through_rows_in_has_a_paging_key(self) -> None:
        """`_rows_in` pages by `_UNIQUE_KEY[table]`; a table missing from it raised KeyError only at run time."""
        from firstseen.repository import _UNIQUE_KEY

        tables = {
            table
            for path in SOURCE.rglob("*.py")
            for table in re.findall(r'_rows_in\(\s*"([a-z_]+)"', path.read_text())
        }
        self.assertIn("raw_job_observations", tables, "the scan found the call sites")
        self.assertEqual(sorted(tables - set(_UNIQUE_KEY)), [])


class WorkerReadBoundsTest(unittest.TestCase):
    def test_every_worker_read_is_paged_or_bounded(self) -> None:
        found: list[str] = []
        for path in sorted(SOURCE.rglob("*.py")):
            found += unbounded_reads(path.read_text(), str(path.relative_to(SOURCE.parents[1])))
        self.assertEqual(
            found,
            [],
            "PostgREST truncates at 1000 rows without an error. Page each read with fetch_all_rows over its unique "
            "key, or put '# bounded: <the hard cap>' on the line above it.",
        )


if __name__ == "__main__":
    unittest.main()
