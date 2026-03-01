export interface LogContext {
  query_id?: string;
  phase?: string;
  counts?: Record<string, number>;
  timings?: Record<string, number>;
}

export const logger = {
  debug: (message: string, context?: LogContext): void => {
    if ((process.env.DEBUG_RAG ?? "").toLowerCase() !== "true") return;
    const parts = [message];
    if (context?.phase) parts.push(`[${context.phase}]`);
    if (context?.timings) {
      const timingStr = Object.entries(context.timings)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(" ");
      parts.push(`(${timingStr})`);
    }
    if (context?.counts) {
      const countStr = Object.entries(context.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      parts.push(`{${countStr}}`);
    }
    console.error(parts.join(" "));
  },
};
