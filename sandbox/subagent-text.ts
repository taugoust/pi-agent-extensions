export function stripSubagentTerminalControls(value: string): string {
  let visible = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      index = skipSubagentEscapeSequence(value, index);
      continue;
    }
    if ((code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) || code === 0x7f) {
      index++;
      continue;
    }
    visible += value[index];
    index++;
  }
  return visible;
}

function skipSubagentEscapeSequence(value: string, start: number): number {
  if (start + 1 >= value.length) return value.length;
  const type = value[start + 1];
  if (type === "[") {
    for (let index = start + 2; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return value.length;
  }
  if (type === "]") {
    for (let index = start + 2; index < value.length; index++) {
      if (value.charCodeAt(index) === 0x07) return index + 1;
      if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") return index + 2;
    }
    return value.length;
  }
  if (type === "P" || type === "X" || type === "^" || type === "_") {
    for (let index = start + 2; index + 1 < value.length; index++) {
      if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") return index + 2;
    }
    return value.length;
  }
  return start + 2;
}
