import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { shader } from "@codemirror/legacy-modes/mode/clike";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { CUSTOM_THEME_TEXTURES } from "#custom-themes/inputs";
import { preludeHelpers } from "../../../lib/custom-theme-spec";

/* The theme editor's code pane: CodeMirror 6 in GLSL, the site's colours,
   the prelude's helpers and inputs in autocomplete, and the checker's and
   the driver's errors marked on the author's lines. */

export interface CodeMark {
  line: number;
  message: string;
}

export interface ThemeCodeEditorHandle {
  jumpTo(line: number): void;
}

const COMPLETIONS: Completion[] = [
  ...preludeHelpers().map((helper) => ({ label: /\s(\w+)\(/.exec(helper.signature)?.[1] ?? "", detail: helper.signature, type: "function" })),
  { label: "u_time", detail: "float, seconds", type: "variable" },
  { label: "u_res", detail: "vec2, canvas pixels", type: "variable" },
  { label: "u_pointer", detail: "vec2, 0..1, y up", type: "variable" },
  { label: "u_scroll", detail: "float, screen heights scrolled", type: "variable" },
  { label: "PX", detail: "float, one pixel in p units", type: "variable" },
  ...Array.from({ length: CUSTOM_THEME_TEXTURES }, (_, index) => [
    { label: `u_tex${index}`, detail: "sampler2D, your image", type: "variable" },
    { label: `u_texSize${index}`, detail: "vec2, its size in pixels", type: "variable" },
  ]).flat(),
  { label: "theme", detail: "vec3 theme(vec2 uv, vec2 p, float t)", type: "function", apply: "vec3 theme(vec2 uv, vec2 p, float t) {\n  \n}" },
];

function complete(context: CompletionContext) {
  const word = context.matchBefore(/\w+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: COMPLETIONS, validFor: /^\w*$/ };
}

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#ff8fc5" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "#8fd0ff" },
  { tag: tags.number, color: "#ffc66d" },
  { tag: [tags.comment, tags.meta], color: "#7d7186", fontStyle: "italic" },
  { tag: tags.operator, color: "#e8dfee" },
  { tag: tags.string, color: "#b5e08a" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: "#f7f1ff" },
]);

const look = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "transparent", color: "#efe7f4" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--color-osu-pink)" },
  ".cm-cursor": { borderLeftColor: "var(--color-osu-pink)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "#6d6274", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.035)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(255,102,171,0.25) !important" },
  ".cm-tooltip": { backgroundColor: "#2a2230", border: "1px solid rgba(255,255,255,0.08)", color: "#efe7f4" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "rgba(255,102,171,0.25)", color: "#fff" },
  ".cm-completionDetail": { color: "#9c8fa6", fontStyle: "normal", marginLeft: "0.8em" },
  ".cm-diagnostic-error": { borderLeftColor: "#ff6b6b" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #ff6b6b" },
}, { dark: true });

export const ThemeCodeEditor = forwardRef<ThemeCodeEditorHandle, {
  value: string;
  onChange: (value: string) => void;
  marks: CodeMark[];
  className?: string;
}>(function ThemeCodeEditor({ value, onChange, marks, className }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          StreamLanguage.define(shader),
          syntaxHighlighting(highlight),
          autocompletion({ override: [complete] }),
          look,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // a new document from outside (a starting point picked), not the author typing
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const { doc } = view.state;
    const diagnostics: Diagnostic[] = marks
      .filter((mark) => mark.line >= 1 && mark.line <= doc.lines)
      .map((mark) => {
        const line = doc.line(mark.line);
        return { from: line.from, to: Math.max(line.from, line.to), severity: "error", message: mark.message };
      });
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [marks]);

  useImperativeHandle(ref, () => ({
    jumpTo(line: number) {
      const view = viewRef.current;
      if (!view) return;
      const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
      view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
      view.focus();
    },
  }), []);

  return <div ref={hostRef} className={className} />;
});
