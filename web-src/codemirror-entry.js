import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter, placeholder, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { json } from '@codemirror/lang-json';
window.CM = { EditorState, EditorView, Compartment, keymap, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter, placeholder, rectangularSelection, crosshairCursor, defaultKeymap, history, historyKeymap, indentWithTab, bracketMatching, syntaxHighlighting, defaultHighlightStyle, indentUnit, searchKeymap, highlightSelectionMatches, json };
