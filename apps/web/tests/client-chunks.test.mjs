import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

// vinext 1.0.0-beta.2 shipped `let{navigateClientSide:e}=await import(`./index-….js`)` in the link chunk while the
// bundler had renamed that chunk's exports to `C`, `E`, `S`, so every <Link> click prevented the browser's navigation
// and then threw. Server-rendered HTML and route tests never click, so nothing caught it. This reads the built client
// chunks and checks that every name read off a dynamically imported chunk is a name that chunk exports.

const CHUNKS = new URL("../dist/client/_next/static/chunks/", import.meta.url);

function exportsOf(source) {
  const names = new Set();
  for (const [, list] of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of list.split(",").map((entry) => entry.trim()).filter(Boolean)) {
      names.add(part.match(/^[\w$]+\s+as\s+([\w$]+)$/)?.[1] ?? part);
    }
  }
  for (const [, name] of source.matchAll(/export\s+(?:const|let|var|async function|function\*?|class)\s+([\w$]+)/g)) names.add(name);
  if (/export\s+default\b/.test(source)) names.add("default");
  return names;
}

/** Names each dynamic import site reads, for the three shapes the bundler emits; other shapes are listed, not guessed. */
function readsOf(head, tail) {
  const member = tail.match(/^\.then\(([\w$]+)=>\1\.([\w$]+)\)/);
  if (member) return { shape: "then-member", names: [member[2]] };
  const destructure = head.match(/\{((?:[\w$]+:[\w$]+,?)+)\}=await (?:[\w$]+\(\(\)=>)?$/);
  if (destructure) return { shape: "destructure", names: destructure[1].split(",").map((pair) => pair.split(":")[0]) };
  const bound = head.match(/let ([\w$]+)=await [\w$]+\(\(\)=>$/);
  const getters = bound && tail.match(/^,__vite__mapDeps\(\[[\d,]*\]\)\);return\{((?:get [\w$]+\(\)\{return [\w$]+\.[\w$]+\},?)*)\}/);
  if (getters) {
    const variable = bound[1].replace(/\$/g, "\\$");
    return { shape: "getters", names: [...getters[1].matchAll(new RegExp(`return ${variable}\\.([\\w$]+)`, "g"))].map((match) => match[1]) };
  }
  return null;
}

export function checkDynamicImports(sources) {
  const result = { sites: 0, checked: [], problems: [], unmatched: [] };
  for (const [file, source] of sources) {
    for (const match of source.matchAll(/import\(`\.\/([^`]+)`\)/g)) {
      result.sites += 1;
      const target = match[1];
      const head = source.slice(Math.max(0, match.index - 200), match.index);
      const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 1500);
      const reads = readsOf(head, tail);
      if (!reads) {
        result.unmatched.push(`${file} -> ${target}: …${head.slice(-60)}‹import›${tail.slice(0, 60)}…`);
        continue;
      }
      result.checked.push({ file, target, ...reads });
      if (!sources.has(target)) {
        result.problems.push(`${file} imports ${target}, which the build does not contain`);
        continue;
      }
      const exported = exportsOf(sources.get(target));
      for (const name of reads.names) {
        if (!exported.has(name)) result.problems.push(`${file} reads ${name} from ${target} (${reads.shape}), which exports only ${[...exported].slice(0, 12).join(", ")}`);
      }
    }
  }
  return result;
}

test("a destructured import of a renamed export is reported", () => {
  const sources = new Map([
    ["index-DiW3rM7D.js", "function h(){}export{h as C,h as E};"],
    ["link-old.js", "async function go(){let{navigateClientSide:e}=await import(`./index-DiW3rM7D.js`);e()}"],
    ["link-new.js", "function load(){return import(`./index-DiW3rM7D.js`).then(e=>e.C)}"],
  ]);
  const result = checkDynamicImports(sources);
  assert.equal(result.checked.length, 2);
  assert.deepEqual(result.problems, ["link-old.js reads navigateClientSide from index-DiW3rM7D.js (destructure), which exports only C, E"]);
});

test("every name the client bundle reads off a dynamically imported chunk is exported by that chunk", (t) => {
  assert.ok(existsSync(CHUNKS), "Run npm run build first: the client chunks are missing.");
  const files = readdirSync(CHUNKS).filter((name) => name.endsWith(".js"));
  const sources = new Map(files.map((name) => [name, readFileSync(new URL(name, CHUNKS), "utf8")]));
  const result = checkDynamicImports(sources);

  assert.deepEqual(result.problems, []);
  assert.ok(
    result.checked.some((site) => /^link-/.test(site.file)),
    "The link chunk's router import was not recognised, so this test no longer covers the defect it was written for.",
  );
  t.diagnostic(`${result.checked.length} of ${result.sites} dynamic import sites checked`);
  for (const site of result.unmatched) t.diagnostic(`not checked: ${site}`);
});
