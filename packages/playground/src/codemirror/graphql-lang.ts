/**
 * CodeMirror 6 language support for GraphQL (schema + query).
 *
 * Lightweight StreamLanguage tokenizer — covers the subset visible in a
 * playground (type definitions, field declarations, queries, mutations,
 * arguments, directives, fragments). No LSP, no schema awareness.
 */
import { StreamLanguage, type StringStream } from "@codemirror/language";

interface State {
  inString: boolean;
  inBlockString: boolean;
}

const KEYWORDS = /^(type|input|enum|interface|union|scalar|schema|extend|implements|fragment|on|query|mutation|subscription|directive|repeatable)\b/;
const BUILTINS = /^(String|Int|Float|Boolean|ID)\b/;
const CONSTANTS = /^(true|false|null)\b/;

function token(stream: StringStream, state: State): string | null {
  // Block string continuation
  if (state.inBlockString) {
    while (!stream.eol()) {
      if (stream.match('"""')) { state.inBlockString = false; return "string"; }
      stream.next();
    }
    return "string";
  }

  // String continuation
  if (state.inString) {
    while (!stream.eol()) {
      const ch = stream.next();
      if (ch === "\\") { stream.next(); continue; }
      if (ch === '"') { state.inString = false; return "string"; }
    }
    return "string";
  }

  // Whitespace
  if (stream.eatSpace()) return null;

  // Comment
  if (stream.eat("#")) { stream.skipToEnd(); return "comment"; }

  // Block string """
  if (stream.match('"""')) {
    while (!stream.eol()) {
      if (stream.match('"""')) return "string";
      stream.next();
    }
    state.inBlockString = true;
    return "string";
  }

  // String
  if (stream.eat('"')) {
    while (!stream.eol()) {
      const ch = stream.next();
      if (ch === "\\") { stream.next(); continue; }
      if (ch === '"') return "string";
    }
    state.inString = true;
    return "string";
  }

  // Numbers
  if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return "number";

  // Punctuation
  const ch = stream.peek();
  if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === "(" || ch === ")") {
    stream.next();
    return "bracket";
  }
  if (ch === ":" || ch === "=" || ch === "|" || ch === "&") { stream.next(); return "operator"; }
  if (ch === "!") { stream.next(); return "operator"; }
  if (ch === ",") { stream.next(); return null; }

  // Spread operator ...
  if (stream.match("...")) return "operator";

  // Directive @name
  if (stream.eat("@")) {
    stream.match(/^[A-Za-z_]\w*/);
    return "meta";
  }

  // Variable $name
  if (stream.eat("$")) {
    stream.match(/^[A-Za-z_]\w*/);
    return "variable";
  }

  // Keywords, builtins, identifiers
  if (stream.match(KEYWORDS)) return "keyword";
  if (stream.match(BUILTINS)) return "type";
  if (stream.match(CONSTANTS)) return "atom";

  // Type names (PascalCase identifiers)
  if (stream.match(/^[A-Z][A-Za-z0-9_]*/)) return "type";

  // Field names / other identifiers
  if (stream.match(/^[a-z_]\w*/i)) return "variable";

  // Fallback
  stream.next();
  return null;
}

export const graphqlLanguage = StreamLanguage.define({
  startState: (): State => ({ inString: false, inBlockString: false }),
  token,
  blankLine(state: State) { state.inString = false; },
});
