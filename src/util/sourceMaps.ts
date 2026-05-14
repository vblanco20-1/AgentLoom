// `new AsyncFunction(...)` prepends one synthetic line to the user source —
// the `async function anonymous(...)` header. To make stack traces useful we
// (a) subtract 1 from every <anonymous>:line:col we recognise as ours, and
// (b) rewrite "<anonymous>" to the real workflow path.

export function remapAsyncFunctionStack(
  err: Error,
  workflowPath: string,
): Error {
  const stack = err.stack;
  if (!stack) return err;
  const rewritten = stack
    .split("\n")
    .map((line) => {
      // Patterns:
      //   "    at <anonymous>:13:5"
      //   "    at eval (<anonymous>:13:5)"
      //   "    at async <anonymous>:13:5"
      return line.replace(
        /<anonymous>:(\d+):(\d+)/g,
        (_match, lineStr: string, col: string) => {
          const adjusted = Math.max(1, parseInt(lineStr, 10) - 1);
          return `${workflowPath}:${adjusted}:${col}`;
        },
      );
    })
    .join("\n");
  err.stack = rewritten;
  return err;
}
