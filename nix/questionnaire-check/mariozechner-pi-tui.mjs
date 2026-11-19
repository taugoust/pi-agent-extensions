export class Editor {
  constructor() {
    throw new Error("Unexpected TUI editor construction");
  }
}
export class Text {
  constructor(text) {
    this.text = text;
  }
}
export const Key = {};
export const matchesKey = () => false;
export const truncateToWidth = (value) => value;
