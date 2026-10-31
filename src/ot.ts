import type { ChangeSet, ChangeSpec, Text } from "@codemirror/state";

/**
 * One step of an operation in the server's form: a positive number retains
 * that many characters, a negative number deletes that many, and a string is
 * inserted. Lengths count Unicode codepoints, while CodeMirror's positions
 * count UTF-16 code units, so every conversion below walks the text.
 */
export type Step = number | string;

/** Returns the number of Unicode codepoints in a string. */
export function unicodeLength(str: string): number {
  let length = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const c of str) ++length;
  return length;
}

/** Returns the number of Unicode codepoints before a position in the document. */
export function unicodeOffset(doc: Text, pos: number): number {
  return unicodeLength(doc.sliceString(0, pos));
}

/** Returns the document position after a number of Unicode codepoints. */
export function unicodePosition(doc: Text, offset: number): number {
  let pos = 0;
  const iter = doc.iter();
  while (offset > 0 && !iter.next().done) {
    for (const c of iter.value) {
      if (offset <= 0) break;
      pos += c.length;
      offset -= 1;
    }
  }
  return Math.min(pos, doc.length);
}

/**
 * Converts a local CodeMirror change set, made against `startDoc`, into the
 * steps of one operation over the whole document.
 */
export function changesToSteps(startDoc: Text, changes: ChangeSet): Step[] {
  const steps: Step[] = [];
  let last = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const kept = unicodeLength(startDoc.sliceString(last, fromA));
    const deleted = unicodeLength(startDoc.sliceString(fromA, toA));
    if (kept > 0) steps.push(kept);
    if (deleted > 0) steps.push(-deleted);
    const text = inserted.toString();
    if (text.length > 0) steps.push(text);
    last = toA;
  });
  const rest = unicodeLength(startDoc.sliceString(last));
  if (rest > 0) steps.push(rest);
  return steps;
}

/**
 * Converts the steps of a remote operation into CodeMirror changes against
 * `doc`, all in the document's coordinates before the operation, as one
 * transaction expects.
 */
export function stepsToChanges(doc: Text, steps: Step[]): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const text = doc.toString();
  let pos = 0; // UTF-16 position in `text`
  const advance = (count: number) => {
    let end = pos;
    while (count > 0 && end < text.length) {
      end += text.codePointAt(end)! > 0xffff ? 2 : 1;
      count -= 1;
    }
    return end;
  };
  for (const step of steps) {
    if (typeof step === "string") {
      changes.push({ from: pos, insert: step });
    } else if (step >= 0) {
      pos = advance(step);
    } else {
      const end = advance(-step);
      changes.push({ from: pos, to: end });
      pos = end;
    }
  }
  return changes;
}
