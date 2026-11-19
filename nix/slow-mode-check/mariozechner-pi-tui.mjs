export function truncateToWidth(text) {
  return String(text);
}

export const Key = {
  enter: "<enter>",
  escape: "<escape>",
  up: "<up>",
  down: "<down>",
  pageUp: "<page-up>",
  pageDown: "<page-down>",
  ctrl: (key) => `<ctrl-${key}>`,
};

export function matchesKey(data, key) {
  return data === key;
}
