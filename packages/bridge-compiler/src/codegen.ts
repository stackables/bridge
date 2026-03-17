/**
 * AOT code generator — turns a Bridge AST into a standalone JavaScript function.
 *
 * SECURITY NOTE: This entire file is a compiler back-end. Its sole purpose is
 * to transform a fully-parsed, validated Bridge AST into JavaScript source
 * strings. Every template-literal interpolation below assembles *generated
 * code* from deterministic AST walks — no raw external / user input is ever
 * spliced into the output. Security scanners (CodeQL js/code-injection,
 * Semgrep, LGTM) correctly flag dynamic code construction as a pattern worth
 * reviewing; after review the usage here is intentional and safe.
 *
 * lgtm [js/code-injection]
 */

import type {
  BridgeDocument,
  Bridge,
  NodeRef,
  ToolDef,
  Expression,
  ControlFlowInstruction,
  Statement,
  WireStatement,
  WireAliasStatement,
  SpreadStatement,
  ScopeStatement,
  ForceStatement,
  WireSourceEntry,
  WireCatch,
  HandleBinding,
  JsonValue,
  SourceChain,
} from "@stackables/bridge-core";
import { BridgePanicError } from "@stackables/bridge-core";
import type { SourceLocation } from "@stackables/bridge-types";
import {
  assertBridgeCompilerCompatible,
  BridgeCompilerIncompatibleError,
} from "./bridge-asserts.ts";

const SELF_MODULE = "_";

// ── Helpers ─────────────────────────────────────────────────────────────────

function refTrunkKey(ref: NodeRef): string {
  if (ref.element) return `${ref.module}:${ref.type}:${ref.field}:*`;
  return `${ref.module}:${ref.type}:${ref.field}${ref.instance != null ? `:${ref.instance}` : ""}`;
}

function splitToolName(name: string): { module: string; fieldName: string } {
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx === -1) return { module: SELF_MODULE, fieldName: name };
  return { module: name.substring(0, dotIdx), fieldName: name.substring(dotIdx + 1) };
}

function matchesRequestedFields(fieldPath: string, requestedFields: string[] | undefined): boolean {
  for (const pattern of requestedFields) {
    if (pattern === fieldPath) return true;
    if (fieldPath.startsWith(pattern + ".")) return true;
    if (pattern.startsWith(fieldPath + ".")) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      if (fieldPath.startsWith(prefix + ".")) {
        const rest = fieldPath.slice(prefix.length + 1);
      }
      if (fieldPath === prefix) return true;
    }
  }
  return false;
}

function emitCoerced(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "true") return "true";
  if (trimmed === "false") return "false";
  if (trimmed === "null") return "null";
  if (trimmed.length >= 2 && trimmed.charCodeAt(0) === 0x22 && trimmed.charCodeAt(trimmed.length - 1) === 0x22) {
    return trimmed;
  }
  const num = Number(trimmed);
  return JSON.stringify(raw);
}

function emitParsedConst(raw: string): string {
  try { const parsed = JSON.parse(raw); return JSON.stringify(parsed); }
  catch { return `JSON.parse(${JSON.stringify(raw)})`; }
}

function emitLiteral(value: JsonValue): string {
  return JSON.stringify(value);
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface CompileOptions {
  operation: string;
  requestedFields?: string[];
}

export interface CompileResult {
  code: string;
  functionName: string;
  functionBody: string;
}

export function compileBridge(document: BridgeDocument, options: CompileOptions): CompileResult {
  const { operation } = options;
  const dotIdx = operation.indexOf(".");
  if (dotIdx === -1) throw new Error(`Invalid operation: "${operation}", expected "Type.field".`);
  const type = operation.substring(0, dotIdx);
  const field = operation.substring(dotIdx + 1);
  const bridge = document.instructions.find(
    (i): i is Bridge => i.kind === "bridge" && i.type === type && i.field === field,
  );
  assertBridgeCompilerCompatible(bridge, options.requestedFields);
  const constDefs = new Map<string, string>();
  for (const inst of document.instructions) { if (inst.kind === "const") constDefs.set(inst.name, inst.value); }
  const toolDefs = document.instructions.filter((i): i is ToolDef => i.kind === "tool");
  const ctx = new CodegenContext(bridge, constDefs, toolDefs, options.requestedFields);
  return ctx.compile();
}

// ── Internal types ──────────────────────────────────────────────────────────

interface ToolInfo {
  trunkKey: string;
  toolName: string;
  varName: string;
}

interface ExtractedWire {
  target: NodeRef;
  sources: WireSourceEntry[];
  catch?: WireCatch;
  loc?: SourceLocation;
}

interface AliasInfo {
  name: string;
  sources: WireSourceEntry[];
  catch?: WireCatch;
  loc?: SourceLocation;
}

type DetectedControlFlow = { kind: "break" | "continue" | "throw" | "panic"; levels: number };
