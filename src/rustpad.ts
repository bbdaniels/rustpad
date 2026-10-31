import {
  Annotation,
  Compartment,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import debounce from "lodash.debounce";
import { OpSeq } from "rustpad-wasm";

import {
  Step,
  changesToSteps,
  stepsToChanges,
  unicodeOffset,
  unicodePosition,
} from "./ot";

/** Options passed in to the Rustpad constructor. */
export type RustpadOptions = {
  readonly uri: string;
  readonly editor: EditorView;
  readonly onConnected?: () => void;
  readonly onDisconnected?: () => void;
  readonly onDesynchronized?: () => void;
  readonly onChangeLanguage?: (language: string) => void;
  readonly onChangeUsers?: (users: Record<number, UserInfo>) => void;
  readonly reconnectInterval?: number;
};

/** A user currently editing the document. */
export type UserInfo = {
  readonly name: string;
  readonly hue: number;
};

/** Browser client for Rustpad. */
class Rustpad {
  private ws?: WebSocket;
  private connecting?: boolean;
  private recentFailures: number = 0;
  private readonly view: EditorView;
  private readonly listener = new Compartment();
  private readonly beforeUnload: (event: BeforeUnloadEvent) => void;
  private readonly tryConnectId: number;
  private readonly resetFailuresId: number;

  // Client-server state
  private me: number = -1;
  private revision: number = 0;
  private outstanding?: OpSeq;
  private buffer?: OpSeq;
  private users: Record<number, UserInfo> = {};
  private userCursors: Record<number, CursorData> = {};
  private myInfo?: UserInfo;
  private cursorData: CursorData = { cursors: [], selections: [] };

  constructor(readonly options: RustpadOptions) {
    this.view = options.editor;
    const cursorUpdate = debounce(() => this.sendCursorData(), 20);
    this.view.dispatch({
      effects: StateEffect.appendConfig.of(
        this.listener.of([
          remoteCursors,
          EditorView.updateListener.of((update) => {
            this.onUpdate(update);
            if (update.selectionSet || update.docChanged) cursorUpdate();
          }),
        ]),
      ),
    });
    this.beforeUnload = (event: BeforeUnloadEvent) => {
      if (this.outstanding) {
        event.preventDefault();
        event.returnValue = "";
      } else {
        delete event.returnValue;
      }
    };
    window.addEventListener("beforeunload", this.beforeUnload);

    const interval = options.reconnectInterval ?? 1000;
    this.tryConnect();
    this.tryConnectId = window.setInterval(() => this.tryConnect(), interval);
    this.resetFailuresId = window.setInterval(
      () => (this.recentFailures = 0),
      15 * interval,
    );
  }

  /** Destroy this Rustpad instance and close any sockets. */
  dispose() {
    window.clearInterval(this.tryConnectId);
    window.clearInterval(this.resetFailuresId);
    this.view.dispatch({ effects: this.listener.reconfigure([]) });
    window.removeEventListener("beforeunload", this.beforeUnload);
    this.ws?.close();
  }

  /** Try to set the language of the editor, if connected. */
  setLanguage(language: string): boolean {
    this.ws?.send(`{"SetLanguage":${JSON.stringify(language)}}`);
    return this.ws !== undefined;
  }

  /** Set the user's information. */
  setInfo(info: UserInfo) {
    this.myInfo = info;
    this.sendInfo();
  }

  /**
   * Attempts a WebSocket connection.
   *
   * Safety Invariant: Until this WebSocket connection is closed, no other
   * connections will be attempted because either `this.ws` or
   * `this.connecting` will be set to a truthy value.
   *
   * Liveness Invariant: After this WebSocket connection closes, either through
   * error or successful end, both `this.connecting` and `this.ws` will be set
   * to falsy values.
   */
  private tryConnect() {
    if (this.connecting || this.ws) return;
    this.connecting = true;
    const ws = new WebSocket(this.options.uri);
    ws.onopen = () => {
      this.connecting = false;
      this.ws = ws;
      this.options.onConnected?.();
      this.users = {};
      this.options.onChangeUsers?.(this.users);
      this.sendInfo();
      this.sendCursorData();
      if (this.outstanding) {
        this.sendOperation(this.outstanding);
      }
    };
    ws.onclose = () => {
      if (this.ws) {
        this.ws = undefined;
        this.options.onDisconnected?.();
        if (++this.recentFailures >= 5) {
          // If we disconnect 5 times within 15 reconnection intervals, then the
          // client is likely desynchronized and needs to refresh.
          this.dispose();
          this.options.onDesynchronized?.();
        }
      } else {
        this.connecting = false;
      }
    };
    ws.onmessage = ({ data }) => {
      if (typeof data === "string") {
        this.handleMessage(JSON.parse(data));
      }
    };
  }

  private handleMessage(msg: ServerMsg) {
    if (msg.Identity !== undefined) {
      this.me = msg.Identity;
    } else if (msg.History !== undefined) {
      const { start, operations } = msg.History;
      if (start > this.revision) {
        console.warn("History message has start greater than last operation.");
        this.ws?.close();
        return;
      }
      for (let i = this.revision - start; i < operations.length; i++) {
        let { id, operation } = operations[i];
        this.revision++;
        if (id === this.me) {
          this.serverAck();
        } else {
          operation = OpSeq.from_str(JSON.stringify(operation));
          this.applyServer(operation);
        }
      }
    } else if (msg.Language !== undefined) {
      this.options.onChangeLanguage?.(msg.Language);
    } else if (msg.UserInfo !== undefined) {
      const { id, info } = msg.UserInfo;
      if (id !== this.me) {
        this.users = { ...this.users };
        if (info) {
          this.users[id] = info;
        } else {
          delete this.users[id];
          delete this.userCursors[id];
        }
        this.updateCursors();
        this.options.onChangeUsers?.(this.users);
      }
    } else if (msg.UserCursor !== undefined) {
      const { id, data } = msg.UserCursor;
      if (id !== this.me) {
        this.userCursors[id] = data;
        this.updateCursors();
      }
    }
  }

  private serverAck() {
    if (!this.outstanding) {
      console.warn("Received serverAck with no outstanding operation.");
      return;
    }
    this.outstanding = this.buffer;
    this.buffer = undefined;
    if (this.outstanding) {
      this.sendOperation(this.outstanding);
    }
  }

  private applyServer(operation: OpSeq) {
    if (this.outstanding) {
      const pair = this.outstanding.transform(operation)!;
      this.outstanding = pair.first();
      operation = pair.second();
      if (this.buffer) {
        const pair = this.buffer.transform(operation)!;
        this.buffer = pair.first();
        operation = pair.second();
      }
    }
    this.applyOperation(operation);
  }

  private applyClient(operation: OpSeq) {
    if (!this.outstanding) {
      this.sendOperation(operation);
      this.outstanding = operation;
    } else if (!this.buffer) {
      this.buffer = operation;
    } else {
      this.buffer = this.buffer.compose(operation);
    }
    this.transformCursorData(operation);
  }

  private sendOperation(operation: OpSeq) {
    const op = operation.to_string();
    this.ws?.send(`{"Edit":{"revision":${this.revision},"operation":${op}}}`);
  }

  private sendInfo() {
    if (this.myInfo) {
      this.ws?.send(`{"ClientInfo":${JSON.stringify(this.myInfo)}}`);
    }
  }

  private sendCursorData() {
    if (!this.buffer) {
      this.ws?.send(`{"CursorData":${JSON.stringify(this.cursorData)}}`);
    }
  }

  private applyOperation(operation: OpSeq) {
    if (operation.is_noop()) return;

    const steps: Step[] = JSON.parse(operation.to_string());
    this.view.dispatch({
      changes: stepsToChanges(this.view.state.doc, steps),
      annotations: [remote.of(true), Transaction.addToHistory.of(false)],
    });

    this.transformCursorData(operation);
    this.updateCursors();
  }

  private transformCursorData(operation: OpSeq) {
    for (const data of Object.values(this.userCursors)) {
      data.cursors = data.cursors.map((c) => operation.transform_index(c));
      data.selections = data.selections.map(([s, e]) => [
        operation.transform_index(s),
        operation.transform_index(e),
      ]);
    }
  }

  /**
   * Redraws the other users' cursors and selections. Never called while the
   * editor is updating (a local edit), when the field maps them instead.
   */
  private updateCursors() {
    const doc = this.view.state.doc;
    const decorations = [];

    for (const [id, data] of Object.entries(this.userCursors)) {
      if (id in this.users) {
        const { hue, name } = this.users[id as any];
        generateCssStyles(hue);

        for (const cursor of data.cursors) {
          const position = unicodePosition(doc, cursor);
          decorations.push(
            Decoration.widget({
              widget: new RemoteCursor(hue, name),
              side: 1,
            }).range(position),
          );
        }
        for (const selection of data.selections) {
          const from = unicodePosition(doc, selection[0]);
          const to = unicodePosition(doc, selection[1]);
          if (from < to) {
            decorations.push(
              Decoration.mark({
                class: `remote-selection-${hue}`,
                attributes: { title: name },
              }).range(from, to),
            );
          }
        }
      }
    }

    this.view.dispatch({
      effects: setRemoteCursors.of(Decoration.set(decorations, true)),
    });
  }

  private onUpdate(update: ViewUpdate) {
    for (const tr of update.transactions) {
      if (tr.docChanged && !tr.annotation(remote)) {
        const steps = changesToSteps(tr.startState.doc, tr.changes);
        const operation = OpSeq.new();
        for (const step of steps) {
          if (typeof step === "string") operation.insert(step);
          else if (step >= 0) operation.retain(step);
          else operation.delete(-step);
        }
        this.applyClient(operation);
      }
    }
    if (update.selectionSet || update.docChanged) {
      const doc = update.state.doc;
      const ranges = update.state.selection.ranges;
      this.cursorData.cursors = ranges.map((r) => unicodeOffset(doc, r.head));
      this.cursorData.selections = ranges.map((r) => [
        unicodeOffset(doc, r.from),
        unicodeOffset(doc, r.to),
      ]);
    }
  }
}

/** Marks the editor transactions that apply a remote operation. */
const remote = Annotation.define<boolean>();

const setRemoteCursors = StateEffect.define<DecorationSet>();

/** The other users' cursors and selections, mapped through every edit. */
const remoteCursors = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCursors)) decorations = effect.value;
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** A remote user's cursor: a colored bar named on hover. */
class RemoteCursor extends WidgetType {
  constructor(
    readonly hue: number,
    readonly name: string,
  ) {
    super();
  }

  eq(other: RemoteCursor) {
    return other.hue === this.hue && other.name === this.name;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = `remote-cursor remote-cursor-${this.hue}`;
    element.title = this.name;
    element.textContent = "\u2060";
    return element;
  }

  ignoreEvent() {
    return true;
  }
}

type UserOperation = {
  id: number;
  operation: any;
};

type CursorData = {
  cursors: number[];
  selections: [number, number][];
};

type ServerMsg = {
  Identity?: number;
  History?: {
    start: number;
    operations: UserOperation[];
  };
  Language?: string;
  UserInfo?: {
    id: number;
    info: UserInfo | null;
  };
  UserCursor?: {
    id: number;
    data: CursorData;
  };
};

/** Cache for private use by `generateCssStyles()`. */
const generatedStyles = new Set<number>();

/** Add CSS styles for a remote user's cursor and selection. */
function generateCssStyles(hue: number) {
  if (!generatedStyles.has(hue)) {
    generatedStyles.add(hue);
    const css = `
      .cm-editor .remote-selection-${hue} {
        background-color: hsla(${hue}, 90%, 80%, 0.5);
      }
      .cm-editor .remote-cursor-${hue} {
        border-left: 2px solid hsl(${hue}, 90%, 25%);
      }
    `;
    const element = document.createElement("style");
    const text = document.createTextNode(css);
    element.appendChild(text);
    document.head.appendChild(element);
  }
}

export default Rustpad;
