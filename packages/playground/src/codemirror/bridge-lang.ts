/**
 * CodeMirror 6 language support for the Bridge DSL.
 *
 * Uses StreamLanguage with a hand-written tokenizer that mirrors the TextMate
 * grammar in bridge-syntax-highlight/syntaxes/bridge.tmLanguage.json.
 */
import { StreamLanguage, type StringStream } from "@codemirror/language";

// ── State ────────────────────────────────────────────────────────────────────

interface State {
  /** Contextual expectation — drives multi-token header highlighting. */
  expect: string;
  /** True while inside an unterminated double-quoted string. */
  inString: boolean;
  /** True until the first real token on the current line is emitted. */
  lineStart: boolean;
}

// ── Contextual state handler ────────────────────────────────────────────────

/**
 * When the tokenizer sees a block-header keyword (bridge, tool, …) it sets
 * `state.expect` so the *following* tokens get the right highlight:
 *
 *   bridge  Query.getWeather  →  keyword · type · def
 *   tool    geo  from  httpCall  →  keyword · def · keyword · variable
 *   with    myTool  as  t  →  keyword · variable · keyword · def
 *
 * Returns the token class string, or `undefined` when the expectation
 * doesn't match (resets state and falls through to general parsing).
 */
function handleExpect(stream: StringStream, state: State): string | null | undefined {
  switch (state.expect) {
    // bridge  TYPE
    case "bridgeType":
      if (stream.match(/^[A-Za-z_]\w*/))  { state.expect = "bridgeDot";  return "type"; }
      state.expect = ""; return undefined;

    // bridge Type  .
    case "bridgeDot":
      if (stream.eat("."))               { state.expect = "bridgeField"; return null; }
      state.expect = ""; return undefined;

    // bridge Type.  FIELD
    case "bridgeField":
      if (stream.match(/^[A-Za-z_]\w*/)) { state.expect = "";            return "def"; }
      state.expect = ""; return undefined;

    // tool / const / define  NAME
    case "toolName":
    case "constName":
    case "defineName": {
      if (stream.match(/^[A-Za-z_]\w*/)) {
        state.expect = state.expect === "toolName" ? "toolFrom" : "";
        return "def";
      }
      state.expect = ""; return undefined;
    }

    // tool name  FROM | EXTENDS
    case "toolFrom":
      if (stream.match(/^from\b/) || stream.match(/^extends\b/)) {
        state.expect = "toolSource";
        return "keyword";
      }
      state.expect = ""; return undefined;

    // tool name from  SOURCE
    case "toolSource":
      if (stream.match(/^[A-Za-z_][\w.]*/)) { state.expect = ""; return "variable"; }
      state.expect = ""; return undefined;

    // with  TARGET
    case "withTarget":
      if (stream.match(/^(input|output|context)\b/)) { state.expect = "withAs"; return "builtin"; }
      if (stream.match(/^const\b/))                  { state.expect = "withAs"; return "keyword"; }
      if (stream.match(/^[A-Za-z_][\w.]*/))          { state.expect = "withAs"; return "variable"; }
      state.expect = ""; return undefined;

    // with target  AS
    case "withAs":
      if (stream.match(/^as\b/)) { state.expect = "withAlias"; return "keyword"; }
      state.expect = ""; return undefined;

    // with target as  ALIAS
    case "withAlias":
      if (stream.match(/^[A-Za-z_]\w*/)) { state.expect = ""; return "def"; }
      state.expect = ""; return undefined;

    default:
      state.expect = ""; return undefined;
  }
}

// ── Main tokenizer ──────────────────────────────────────────────────────────

function token(stream: StringStream, state: State): string | null {
  // Track whether we've emitted a real token on this line yet.
  if (stream.sol()) state.lineStart = true;

  // ── String continuation (unterminated on previous line) ────────────────
  if (state.inString) {
    while (!stream.eol()) {
      const ch = stream.next();
      if (ch === "\\") { stream.next(); continue; }
      if (ch === '"')  { state.inString = false; return "string"; }
    }
    return "string";
  }

  // ── Whitespace ────────────────────────────────────────────────────────
  if (stream.eatSpace()) return null;

  // ── Comment ───────────────────────────────────────────────────────────
  if (stream.eat("#")) { stream.skipToEnd(); return "comment"; }

  // ── Double-quoted string ──────────────────────────────────────────────
  if (stream.eat('"')) {
    while (!stream.eol()) {
      const ch = stream.next();
      if (ch === "\\") { stream.next(); continue; }
      if (ch === '"')  { state.lineStart = false; return "string"; }
    }
    state.inString = true;
    state.lineStart = false;
    return "string";
  }

  // ── Contextual (header) tokens ────────────────────────────────────────
  if (state.expect) {
    const result = handleExpect(stream, state);
    if (result !== undefined) { state.lineStart = false; return result; }
  }

  // ── Brackets ──────────────────────────────────────────────────────────
  const ch = stream.peek();
  if (ch === "{" || ch === "}" || ch === "[" || ch === "]") {
    stream.next();
    state.lineStart = false;
    return "bracket";
  }

  // ── Wire operators (order matters: <-! before <-) ─────────────────────
  if (stream.match("<-!") || stream.match("<-")) { state.lineStart = false; return "operator"; }
  if (stream.match("||")  || stream.match("??")) { state.lineStart = false; return "operator"; }
  if (stream.match("="))                          { state.lineStart = false; return "operator"; }
  if (stream.eat(":"))                            { state.lineStart = false; return "operator"; }

  // ── Keywords (set contextual expectation) ─────────────────────────────
  if (stream.match(/^on\s+error\b/))  { state.lineStart = false; return "keyword"; }
  if (stream.match(/^version\b/))     { state.lineStart = false; return "keyword"; }
  if (stream.match(/^bridge\b/))      { state.expect = "bridgeType";  state.lineStart = false; return "keyword"; }
  if (stream.match(/^tool\b/))        { state.expect = "toolName";    state.lineStart = false; return "keyword"; }
  if (stream.match(/^define\b/))      { state.expect = "defineName";  state.lineStart = false; return "keyword"; }
  if (stream.match(/^const\b/))       { state.expect = "constName";   state.lineStart = false; return "keyword"; }
  if (stream.match(/^with\b/))        { state.expect = "withTarget";  state.lineStart = false; return "keyword"; }
  if (stream.match(/^as\b/))          { state.lineStart = false; return "keyword"; }

  // ── HTTP method constants ─────────────────────────────────────────────
  if (stream.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/)) {
    state.lineStart = false;
    return "atom";
  }

  // ── Booleans / null ───────────────────────────────────────────────────
  if (stream.match(/^(true|false|null)\b/)) { state.lineStart = false; return "atom"; }

  // ── Numbers ───────────────────────────────────────────────────────────
  if (stream.match(/^-?\d+(\.\d+)?/)) { state.lineStart = false; return "number"; }

  // ── URL paths (after = or standalone) ─────────────────────────────────
  if (stream.match(/^\/[\w/.%-]*/)) { state.lineStart = false; return "string-2"; }

  // ── Reserved handles ──────────────────────────────────────────────────
  if (stream.match(/^(input|output|context)\b/)) { state.lineStart = false; return "builtin"; }

  // ── Dot-prefixed property — only when first token on the line ─────────
  //    .baseUrl = "..."   .headers.Authorization <- ctx.token
  if (state.lineStart && ch === ".") {
    stream.next();
    stream.match(/^[\w-]+(?:\.[\w-]+)*/);
    state.lineStart = false;
    return "property";
  }

  // ── Dot (path separator mid-identifier: geo.items) ────────────────────
  if (stream.eat(".")) return null;

  // ── Identifier ────────────────────────────────────────────────────────
  if (stream.match(/^[A-Za-z_]\w*/)) { state.lineStart = false; return "variable"; }

  // ── Fallback — consume one char to avoid infinite loops ───────────────
  stream.next();
  state.lineStart = false;
  return null;
}

// ── Export ───────────────────────────────────────────────────────────────────

export const bridgeLanguage = StreamLanguage.define({
  startState: (): State => ({ expect: "", inString: false, lineStart: true }),
  token,
  blankLine(state: State) { state.expect = ""; state.lineStart = true; },
});
