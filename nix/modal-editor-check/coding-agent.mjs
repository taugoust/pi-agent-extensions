export class CustomEditor {
  constructor(tui) {
    this.tui = tui;
  }
  getPaddingX() {
    return 0;
  }
  getCursor() {
    return { line: 0, col: 0 };
  }
  getLines() {
    return [this.tui.text ?? ""];
  }
  handleInput() {}
  render() {
    return [...this.tui.renderLines];
  }
}
export function copyToClipboard() {}
