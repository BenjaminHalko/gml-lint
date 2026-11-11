import type { Position, Range, SourceLocation } from "./ast.js";

/** Maps UTF-16 offsets to 1-based line / 0-based column positions. */
export class LineMap {
  /** Offset at which each line starts. */
  readonly lineStarts: number[];
  readonly text: string;

  constructor(text: string) {
    this.text = text;
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 /* \n */) {
        starts.push(i + 1);
      } else if (c === 13 /* \r */) {
        if (text.charCodeAt(i + 1) === 10) i++;
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  position(offset: number): Position {
    const starts = this.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo]! };
  }

  loc(range: Range): SourceLocation {
    return { start: this.position(range[0]), end: this.position(range[1]) };
  }

  /** Offset of a 1-based line / 0-based column. */
  offset(position: Position): number {
    const start = this.lineStarts[position.line - 1];
    if (start === undefined) return this.text.length;
    return Math.min(start + position.column, this.text.length);
  }
}
