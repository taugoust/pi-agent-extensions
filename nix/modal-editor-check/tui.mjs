export const CURSOR_MARKER = "\x1b_pi:c\x07";
export function matchesKey(data, key) {
  return key === "escape" && data === "\x1b";
}
export function truncateToWidth(value, width) {
  return String(value).slice(0, width);
}
export function visibleWidth(value) {
  return [
    ...String(value)
      .replaceAll(CURSOR_MARKER, "")
      .replace(/\x1b\[[0-9;]*m/g, ""),
  ].length;
}
