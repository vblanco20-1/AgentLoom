import { parse } from "@babel/parser";
import type { WorkflowMeta } from "../bus/events.ts";

export interface ExtractedMeta {
  meta: WorkflowMeta;
  // Source rewritten with the `export` keyword and any `export const meta = {...}`
  // statements replaced by same-length comment substitution. Line numbers are
  // preserved 1:1, so AsyncFunction stack traces still map cleanly.
  source: string;
}

export function extractMeta(rawSource: string): ExtractedMeta {
  const ast = parse(rawSource, {
    sourceType: "module",
    plugins: ["typescript"],
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });

  const src = rawSource;
  let meta: WorkflowMeta | null = null;
  const replacements: Array<{ start: number; end: number }> = [];

  for (const node of ast.program.body) {
    if (node.type !== "ExportNamedDeclaration") continue;
    if (!node.declaration) {
      // `export { meta }` style — strip the keyword and pretend the rest is fine.
      replacements.push({ start: node.start!, end: node.end! });
      continue;
    }
    if (node.declaration.type !== "VariableDeclaration") {
      // `export function foo() {}` etc. — strip just the `export` keyword.
      // The declaration body keeps its position.
      const exportKw = node.start!;
      const declStart = node.declaration.start!;
      replacements.push({ start: exportKw, end: declStart });
      continue;
    }
    let extractedFromThis = false;
    for (const decl of node.declaration.declarations) {
      if (
        decl.id.type === "Identifier" &&
        decl.id.name === "meta" &&
        decl.init
      ) {
        const initSrc = src.slice(decl.init.start!, decl.init.end!);
        try {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          meta = new Function(`return (${initSrc});`)() as WorkflowMeta;
          extractedFromThis = true;
        } catch (err) {
          throw new Error(
            `Failed to evaluate workflow meta literal: ${(err as Error).message}`,
          );
        }
      }
    }
    // Strip the whole `export const ...` statement when it contained meta;
    // otherwise just remove the `export` keyword to keep its locals.
    if (extractedFromThis) {
      replacements.push({ start: node.start!, end: node.end! });
    } else {
      const declStart = node.declaration.start!;
      replacements.push({ start: node.start!, end: declStart });
    }
  }

  if (!meta) {
    throw new Error(
      `Workflow source has no \`export const meta = { ... }\` statement.`,
    );
  }

  // Same-length comment substitution preserves line/column numbers.
  let out = src;
  // Replace from the end backwards so earlier offsets remain valid.
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    const len = r.end - r.start;
    if (len < 4) {
      // Cannot fit "/**/" — pad with spaces.
      out = out.slice(0, r.start) + " ".repeat(len) + out.slice(r.end);
      continue;
    }
    const original = out.slice(r.start, r.end);
    // Build a comment that preserves all newlines from the original.
    const sameLen = blankPreservingNewlines(original);
    out = out.slice(0, r.start) + sameLen + out.slice(r.end);
  }

  // Validate shape.
  if (!meta || typeof meta !== "object") {
    throw new Error("Workflow meta must be an object literal.");
  }
  if (typeof meta.name !== "string" || meta.name.length === 0) {
    throw new Error("Workflow meta.name must be a non-empty string.");
  }

  return { meta, source: out };
}

function blankPreservingNewlines(original: string): string {
  // Wrap in /* ... */ but leave \n characters untouched so line numbers match.
  // Layout: "/*" + (interior with all non-\n chars replaced by space) + "*/"
  if (original.length < 4) return " ".repeat(original.length);
  const inner = original.slice(2, -2);
  const blanked = inner.replace(/[^\n]/g, " ");
  return "/*" + blanked + "*/";
}
