import { z } from "zod";
export const inputSchema = z
  .object({
    run_url: z.string().url().optional(),
    repository: z
      .string()
      .regex(/^[-\w.]+\/[-\w.]+$/)
      .optional(),
    run_id: z.number().int().positive().optional(),
    repo_path: z
      .string()
      .regex(/^(?:\/|[A-Za-z]:[\\/])/, "Use an absolute repository path")
      .optional(),
    cursor: z.string().max(16000).optional(),
    max_chars: z.number().int().min(1000).max(64000).default(16000),
  })
  .strict()
  .refine(
    (input) =>
      !!(
        input.cursor ||
        input.run_url ||
        input.repo_path ||
        (input.repository && input.run_id)
      ),
    { message: "Provide cursor, run_url, repo_path, or repository+run_id" },
  );
