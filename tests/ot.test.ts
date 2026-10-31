// Randomized checks of the conversions between CodeMirror changes and
// Rustpad operations, against a reference that works on codepoint arrays.
// Run with `npm test` (Node 23.6 or newer strips the types).
import { ChangeSet, Text } from "@codemirror/state";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Step,
  changesToSteps,
  stepsToChanges,
  unicodeOffset,
  unicodePosition,
} from "../src/ot.ts";

const alphabet = ["a", "b", " ", "\n", "\r", "\t", "é", "😀", "𝄞", "中"];

function random(n: number) {
  return Math.floor(Math.random() * n);
}

function randomString(max: number) {
  let s = "";
  for (let i = random(max); i > 0; i--) s += alphabet[random(alphabet.length)];
  return s;
}

function doc(s: string) {
  return Text.of(s.split("\n"));
}

/** Applies steps to a string as the server does, by codepoints. */
function applySteps(s: string, steps: Step[]) {
  const chars = [...s];
  let out = "";
  let i = 0;
  for (const step of steps) {
    if (typeof step === "string") out += step;
    else if (step >= 0) {
      out += chars.slice(i, i + step).join("");
      i += step;
    } else i += -step;
  }
  assert.equal(i, chars.length, "operation must cover the whole document");
  return out;
}

/** A random operation over a string of `length` codepoints. */
function randomSteps(length: number): Step[] {
  const steps: Step[] = [];
  let left = length;
  while (left > 0) {
    const n = 1 + random(Math.min(left, 4));
    const kind = random(3);
    if (kind === 0) steps.push(n);
    else if (kind === 1) steps.push(-n);
    else {
      steps.push(randomString(4) || "x");
      continue;
    }
    left -= n;
  }
  if (random(2)) steps.push(randomString(3) || "y");
  return steps;
}

test("positions and codepoint offsets round-trip", () => {
  for (let k = 0; k < 500; k++) {
    const s = randomString(30);
    const d = doc(s);
    const count = [...s].length;
    for (let cp = 0; cp <= count; cp++) {
      assert.equal(unicodeOffset(d, unicodePosition(d, cp)), cp);
    }
  }
});

test("local changes become the same edit as an operation", () => {
  for (let k = 0; k < 2000; k++) {
    const s = randomString(30);
    const d = doc(s);
    // Random non-overlapping changes at codepoint boundaries.
    const cps = [...s].length;
    const points = [...new Set([random(cps + 1), random(cps + 1), random(cps + 1), random(cps + 1)])].sort((a, b) => a - b);
    const specs = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      specs.push({
        from: unicodePosition(d, points[i]),
        to: unicodePosition(d, points[i + 1]),
        insert: randomString(3),
      });
    }
    const changes = ChangeSet.of(specs, d.length, "\n");
    const expected = changes.apply(d).toString();
    assert.equal(applySteps(s, changesToSteps(d, changes)), expected, JSON.stringify({ s, specs }));
  }
});

test("remote operations become the same edit in the editor", () => {
  for (let k = 0; k < 2000; k++) {
    const s = randomString(30);
    const d = doc(s);
    const steps = randomSteps([...s].length);
    const changes = ChangeSet.of(stepsToChanges(d, steps), d.length, "\n");
    assert.equal(changes.apply(d).toString(), applySteps(s, steps), JSON.stringify({ s, steps }));
  }
});
