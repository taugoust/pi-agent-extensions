export class Container {
  constructor() {
    this.children = [];
  }
  addChild(child) {
    this.children.push(child);
  }
  clear() {
    this.children = [];
  }
  render(width) {
    return this.children.flatMap((child) => (child.render ? child.render(width) : []));
  }
}
export class Box extends Container {
  constructor(_x = 0, _y = 0, bgFn = (text) => text) {
    super();
    this.bgFn = bgFn;
  }
  setBgFn(bgFn) {
    this.bgFn = bgFn;
  }
  render(width) {
    return super.render(width).map((line) => this.bgFn(line));
  }
}
export class Spacer {
  constructor(lines = 1) {
    this.lines = lines;
  }
  render() {
    return Array(this.lines).fill("");
  }
}
export class Text {
  constructor(text, x = 0, y = 0) {
    this.text = text;
    this.x = x;
    this.y = y;
  }
  render() {
    return String(this.text || "").split("\n");
  }
}
export class Markdown extends Text {}
export const Key = {
  enter: "<enter>",
  escape: "<escape>",
  up: "<up>",
  down: "<down>",
  pageUp: "<page-up>",
  pageDown: "<page-down>",
};
export function matchesKey(data, key) {
  return data === key;
}
export function truncateToWidth(text) {
  return String(text);
}
export function visibleWidth(text) {
  return String(text).length;
}
export function wrapTextWithAnsi(text, width) {
  const value = String(text);
  if (value.length <= width) return [value];
  const lines = [];
  for (let offset = 0; offset < value.length; offset += width)
    lines.push(value.slice(offset, offset + width));
  return lines;
}
