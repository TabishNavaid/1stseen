import { createElement, type ReactElement } from "react";
import { BIRD_MARK, MARK_ID_SLOT, type BirdMarkKind, type MarkNode } from "@/lib/brand/bird-mark";
import { cn } from "@/lib/utils";

/**
 * The mark, drawn inline from `lib/brand/bird-mark.ts` (which `scripts/build-brand-art.mjs` writes out of
 * `design-refs/icon`). It never costs a request and never arrives after the word beside it.
 *
 * The drawing clips itself to its own tile, and a clip is reached by id, which is a name the whole document shares.
 * A page wears the mark at both of its ends, so each copy is given its own `markId`; `brand-mark.tsx` names them and
 * `tests/brand-mark.test.mjs` checks that a page never sends the same one twice.
 *
 * Every element is rendered as an element. Nothing here sets markup from a string, and nothing changes the drawing:
 * the attributes are the file's own.
 */

function element(node: MarkNode, id: string, key: number): ReactElement {
  const attrs = Object.fromEntries(Object.entries(node.attrs).map(([name, value]) => [name, value.replaceAll(MARK_ID_SLOT, id)]));
  return createElement(node.tag, { key, ...attrs }, node.children?.map((child, index) => element(child, id, index)));
}

export function BirdMark({ markId, kind = "mark", className }: { markId: string; kind?: BirdMarkKind; className?: string }) {
  const art = BIRD_MARK[kind];
  return (
    <svg viewBox={art.viewBox} className={cn("shrink-0 select-none", className)} aria-hidden="true" focusable="false">
      {art.nodes.map((node, index) => element(node, markId, index))}
    </svg>
  );
}
