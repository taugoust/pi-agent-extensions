/** How a fetched response that didn't fit is reported, and where its bytes are kept. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Keeps already-downloaded bytes in a private temporary file, so nothing is fetched again. */
export async function retainResponse(body: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-fetch-"));
  const path = join(directory, "response");
  await writeFile(path, body, { mode: 0o600 });
  return path;
}

/**
 * Notes for a response the result can't show in full. A download that hit maxBodyBytes is never
 * called complete, and shortened output points to a retained copy instead of a new request.
 */
export async function truncationNotes(
  body: Buffer,
  downloadTruncated: boolean,
  presentationTruncated: boolean,
  maxBodyBytes: number,
): Promise<{ notes: string[]; fullResponsePath?: string }> {
  const notes: string[] = [];
  if (downloadTruncated)
    notes.push(
      `[Download stopped at maxBodyBytes (${maxBodyBytes} bytes); the response is incomplete. ` +
        "A larger maxBodyBytes would request it again.]",
    );
  if (!presentationTruncated) return { notes };
  const fullResponsePath = await retainResponse(body);
  const kind = downloadTruncated ? "partial" : "full";
  notes.push(
    `[Showing part of the response. The ${kind} downloaded response (${body.length} bytes) ` +
      `is saved at ${fullResponsePath}.]`,
  );
  return { notes, fullResponsePath };
}
