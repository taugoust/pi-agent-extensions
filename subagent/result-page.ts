/** Page only at UTF-8 boundaries; offsets always refer to the selected human view. */
export function resultPage(text: string, offset = 0, limit = 48 * 1024) {
  const bytes = Buffer.from(text, "utf8");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 48 * 1024) throw new Error("Invalid result page");
  if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error("Result offset is not a UTF-8 character boundary");
  let end = Math.min(bytes.length, offset + limit);
  while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end--;
  if (end === offset && offset < bytes.length) throw new Error("Result limit ends before one complete UTF-8 character");
  return { text: bytes.subarray(offset, end).toString("utf8"), offset, nextOffset: end, complete: end === bytes.length };
}
