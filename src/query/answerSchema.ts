import { z } from "zod";

/**
 * What your app will accept from the LLM.
 * - citations must reference chunk UUIDs you actually retrieved.
 * - abstained answers must have empty citations + missing_info.
 */
export const RagAnswerSchema = z
  .object({
    abstained: z.boolean(),
    answer: z.string().min(1),
    citations: z.array(z.string().uuid()),
    missing_info: z.string().min(1).optional(),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .superRefine((val, ctx) => {
    if (val.abstained) {
      if (val.citations.length !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["citations"],
          message: "If abstained=true, citations must be empty.",
        });
      }
      if (!val.missing_info) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["missing_info"],
          message: "If abstained=true, missing_info is required.",
        });
      }
    } else {
      if (val.citations.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["citations"],
          message: "If abstained=false, provide at least 1 citation.",
        });
      }
    }
  });

export type RagAnswer = z.infer<typeof RagAnswerSchema>;

/**
 * JSON Schema for Ollama structured outputs (passed via `format`).
 * Note: JSON Schema here helps the model comply, but your Zod parse is the real gate.
 */
export const RagAnswerJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    abstained: { type: "boolean" },
    answer: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "string",
        // loose UUID-ish pattern (Ollama-side)
        pattern:
          "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      },
    },
    missing_info: { type: "string" },
    confidence: { enum: ["low", "medium", "high"] },
  },
  required: ["abstained", "answer", "citations", "confidence"],
} as const;
