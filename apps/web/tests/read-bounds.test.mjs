/**
 * Every PostgREST read in the web app is paged or provably bounded.
 *
 * PostgREST returns at most `db.max_rows` (1000) rows per response and reports no error when it truncates. The
 * dashboard once read 1,000 of 3,451 roles, the role page listed 60 of 114 contributions, and the dashboard's
 * "Confirmed openings" showed the length of a 12-row list as if it were the total. So a read is allowed in exactly two
 * shapes:
 *
 * - paged to exhaustion by `fetchAll` / `fetchAllIn` (`lib/supabase/paging.ts`), over the relation's unique key; or
 * - annotated `// bounded: <why>` directly above its statement (or inside it), naming a hard cap: a unique key, a
 *   single row, a count, a deliberate top-N the page presents as such, or a function whose SQL caps its rows.
 *
 * This walks the source with the TypeScript compiler, not regexes, and fails on any read in neither shape. It checks
 * itself against small snippets first, so it cannot pass by finding nothing.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const WEB = new URL("..", import.meta.url).pathname;
const SCAN = ["lib", "app", "components", "cloudflare"];
const PAGERS = new Set(["fetchAll", "fetchAllIn"]);
const WRITES = new Set(["insert", "update", "upsert", "delete"]);
const MIN_REASON = 15;

/** Method names along a call chain, outermost first. */
function chainNames(node) {
  const names = [];
  let current = node;
  for (;;) {
    if (ts.isCallExpression(current)) current = current.expression;
    else if (ts.isPropertyAccessExpression(current)) {
      names.push(current.name.text);
      current = current.expression;
    } else if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression;
    else return names;
  }
}

/** A chain is a read when it reaches PostgREST through .from(table) with a select, or .rpc(fn), and writes nothing. */
function isRead(call) {
  const names = chainNames(call);
  if (names.some((name) => WRITES.has(name))) return false;
  if (names.includes("rpc")) return true;
  if (!names.includes("from")) return false;
  const from = findCall(call, "from");
  if (!from) return false;
  // Array.from(...) and Buffer.from(...) are not reads.
  const receiver = ts.isPropertyAccessExpression(from.expression) ? from.expression.expression : null;
  if (receiver && ts.isIdentifier(receiver) && ["Array", "Buffer", "Uint8Array"].includes(receiver.text)) return false;
  // supabase-js: .from(table).select(...); the public reader: reader.from("table", "columns").
  if (names.includes("select")) return true;
  return from.arguments.length >= 2 && ts.isStringLiteralLike(from.arguments[0]);
}

function findCall(node, name) {
  let current = node;
  for (;;) {
    if (ts.isCallExpression(current)) {
      if (ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === name) return current;
      current = current.expression;
    } else if (ts.isPropertyAccessExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else return null;
  }
}

/** True when `node` is part of a larger chain (so only the outermost call of a chain is reported). */
function isInnerLink(node) {
  const parent = node.parent;
  return Boolean(parent) && (ts.isPropertyAccessExpression(parent) || (ts.isCallExpression(parent) && parent.expression === node));
}

function paged(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && PAGERS.has(current.expression.text)) return true;
  }
  return false;
}

function enclosingStatement(node) {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent) && !ts.isBlock(current.parent) && !ts.isModuleBlock(current.parent)) {
    if (ts.isStatement(current) && !ts.isExpressionStatement(current.parent ?? current)) {
      if (ts.isVariableStatement(current) || ts.isReturnStatement(current) || ts.isExpressionStatement(current) || ts.isIfStatement(current)) return current;
    }
    current = current.parent;
  }
  return current;
}

/**
 * The bound must sit with the read itself: on the line directly above it, on its own lines, or in the leading comment
 * of a statement the read begins. So one comment above a Promise.all cannot vouch for every read inside it.
 */
function annotated(source, statement, call) {
  const lines = source.text.split("\n");
  const first = source.getLineAndCharacterOfPosition(call.getStart()).line;
  const last = source.getLineAndCharacterOfPosition(call.getEnd()).line;
  const candidates = lines.slice(Math.max(0, first - 1), last + 1);
  if (source.getLineAndCharacterOfPosition(statement.getStart()).line === first) {
    candidates.push(...source.text.slice(statement.getFullStart(), statement.getStart()).split("\n"));
  }
  return candidates.some((line) => {
    const at = line.indexOf("// bounded:");
    return at >= 0 && line.slice(at + "// bounded:".length).trim().length >= MIN_REASON;
  });
}

export function unboundedReads(text, fileName = "snippet.ts") {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && !isInnerLink(node) && isRead(node) && !paged(node)) {
      const statement = enclosingStatement(node);
      if (!annotated(source, statement, node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${fileName}:${line + 1}: ${text.split("\n")[line].trim().slice(0, 100)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

test("the checker flags an unbounded read and passes the two allowed shapes", () => {
  assert.equal(unboundedReads('const rows = await admin.from("forecasts").select("*").eq("user_id", id);').length, 1);
  assert.equal(unboundedReads('const rows = await reader.from("forecasts", "id,window_start").eq("canonical_role_id", id);').length, 1);
  assert.equal(unboundedReads('const { data } = await reader.rpc("dashboard_filter_options");').length, 1);
  assert.equal(unboundedReads('// bounded: small\nconst rows = await admin.from("forecasts").select("*");').length, 1, "a reason must name a cap");
  assert.deepEqual(unboundedReads('const rows = await fetchAll(() => admin.from("forecasts").select("*"), "forecasts", "id");'), []);
  assert.deepEqual(unboundedReads('const rows = await fetchAllIn((ids) => reader.from("forecasts", "id").in("id", ids), ids, "forecasts", "id");'), []);
  assert.deepEqual(unboundedReads('// bounded: one row, the forecast by its primary key\nconst row = await reader.from("forecasts", "id").eq("id", id).maybeSingle();'), []);
  assert.deepEqual(unboundedReads('await admin.from("watchlist_items").insert({ user_id: id });'), [], "a write is not a read");
  assert.deepEqual(unboundedReads('const bytes = Array.from(new Uint8Array(buffer), (byte) => byte); const raw = Buffer.from(key, "base64url");'), []);
  assert.deepEqual(unboundedReads('await admin.from("watchlist_items").delete().eq("user_id", id).select("id");'), [], "a delete that returns rows is still a write");
  assert.equal(
    unboundedReads('// bounded: one row, the forecast by its primary key\nconst [a, b] = await Promise.all([\n  reader.from("forecasts", "id").eq("id", id).maybeSingle(),\n  reader.from("signals", "id").eq("company_id", id),\n]);').length,
    2,
    "one comment above a Promise.all does not vouch for the reads inside it",
  );
});

test("every read in the web app is paged or bounded", () => {
  const found = SCAN.flatMap((directory) => files(join(WEB, directory)))
    .flatMap((path) => unboundedReads(readFileSync(path, "utf8"), relative(WEB, path)));
  assert.deepEqual(
    found,
    [],
    "PostgREST truncates at 1000 rows without an error. Page each read with fetchAll/fetchAllIn over its unique key, or put "
      + "'// bounded: <the hard cap>' on the line above it.",
  );
});
