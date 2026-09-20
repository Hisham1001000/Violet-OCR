// Importing this from a client component is a build error, not a code review
// comment: signs calls to the Modal pipeline.
import "server-only";

// ── Pipeline trigger helpers ──────────────────────────────────────────────────
// Shared by every route that calls the Python/Modal OCR pipeline (upload,
// reprocess, recrop, manual-upload, export). Centralizes the shared-secret
// header so the auth token is attached consistently everywhere.
//
// Security: the pipeline endpoints (Modal `process-document` / `generate-excel`
// and the local dev server) authenticate with a shared secret.
// When PIPELINE_SHARED_SECRET is set in the Vercel env, every trigger request
// carries it as `X-Pipeline-Token`; the pipeline enforces it when the same
// secret is configured on its side. Set the SAME value in both places to close
// the endpoint to the public internet.

/**
 * Headers for a pipeline trigger request. Always JSON; adds the shared-secret
 * token when configured.
 */
export function pipelineHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.PIPELINE_SHARED_SECRET;
  if (token) headers["X-Pipeline-Token"] = token;
  return headers;
}
