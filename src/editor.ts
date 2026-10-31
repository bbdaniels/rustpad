import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription, indentUnit } from "@codemirror/language";
import { languages as languageData } from "@codemirror/language-data";
import { Compartment, EditorState, RangeSetBuilder } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  keymap,
} from "@codemirror/view";
import { basicSetup } from "codemirror";

const TAB_SIZE = 4;

const languageCompartment = new Compartment();
const themeCompartment = new Compartment();
const wrapCompartment = new Compartment();

/** Creates the editor in `parent`, empty, with plain text and wrapping on. */
export function createEditor(parent: HTMLElement): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        // Keep a lone "\r" as a character: Rustpad's operations count every
        // codepoint, so the document must hold exactly what the server holds.
        EditorState.lineSeparator.of("\n"),
        EditorState.tabSize.of(TAB_SIZE),
        indentUnit.of(" ".repeat(TAB_SIZE)),
        languageCompartment.of([]),
        themeCompartment.of([]),
        wrapCompartment.of(wrapping(true, false)),
      ],
    }),
  });
}

let languageRequest = "";

/** Sets the syntax highlighting to one of the names in languages.json. */
export function setEditorLanguage(view: EditorView, language: string) {
  languageRequest = language;
  const description =
    language === "plaintext"
      ? null
      : LanguageDescription.matchLanguageName(languageData, language, true);
  if (!description) {
    view.dispatch({ effects: languageCompartment.reconfigure([]) });
    return;
  }
  description.load().then((support) => {
    if (languageRequest === language) {
      view.dispatch({ effects: languageCompartment.reconfigure(support) });
    }
  });
}

export function setEditorDarkMode(view: EditorView, dark: boolean) {
  view.dispatch({ effects: themeCompartment.reconfigure(dark ? oneDark : []) });
}

export function setEditorWrap(
  view: EditorView,
  wrap: boolean,
  markdown: boolean,
) {
  view.dispatch({
    effects: wrapCompartment.reconfigure(wrapping(wrap, markdown)),
  });
}

function wrapping(wrap: boolean, markdown: boolean) {
  return wrap ? [EditorView.lineWrapping, hangingIndent(markdown)] : [];
}

/**
 * Wrapped lines continue at the line's own indentation, and in Markdown at
 * the text after a list marker or quote marker, as Monaco's wrapping indent
 * did. Each line gets a hanging indent of that many columns.
 */
function hangingIndent(markdown: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, markdown);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = build(update.view, markdown);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function build(view: EditorView, markdown: boolean): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let lastLine = -1;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const columns = hangingColumns(line.text, markdown);
      if (columns > 0 && line.number > lastLine) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: {
              style: `padding-left: calc(${columns}ch + 6px); text-indent: -${columns}ch`,
            },
          }),
        );
      }
      lastLine = line.number;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const markdownMarker = /^(?:[-*+]|\d+[.)])[ \t]+|^>[ \t]?/;

function hangingColumns(text: string, markdown: boolean): number {
  let columns = 0;
  let i = 0;
  for (; i < text.length; i++) {
    if (text[i] === " ") columns += 1;
    else if (text[i] === "\t") columns += TAB_SIZE - (columns % TAB_SIZE);
    else break;
  }
  if (markdown) {
    const marker = markdownMarker.exec(text.slice(i));
    if (marker) columns += marker[0].length;
  }
  return columns;
}
