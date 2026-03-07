import type { SourceLocation } from "./types.ts";

export type FormatBridgeErrorOptions = {
  source?: string;
  filename?: string;
};

function getMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getBridgeMetadata(err: unknown): {
  bridgeLoc?: SourceLocation;
  bridgeSource?: string;
  bridgeFilename?: string;
} | null {
  if (!err || (typeof err !== "object" && typeof err !== "function")) {
    return null;
  }

  return err as {
    bridgeLoc?: SourceLocation;
    bridgeSource?: string;
    bridgeFilename?: string;
  };
}

function getBridgeLoc(err: unknown): SourceLocation | undefined {
  return getBridgeMetadata(err)?.bridgeLoc;
}

function getBridgeSource(
  err: unknown,
  options: FormatBridgeErrorOptions,
): string | undefined {
  return options.source ?? getBridgeMetadata(err)?.bridgeSource;
}

function getBridgeFilename(
  err: unknown,
  options: FormatBridgeErrorOptions,
): string {
  return (
    options.filename ?? getBridgeMetadata(err)?.bridgeFilename ?? "<bridge>"
  );
}

function renderSnippet(source: string, loc: SourceLocation): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const targetLine = lines[loc.startLine - 1] ?? "";
  const previousLine = loc.startLine > 1 ? lines[loc.startLine - 2] : undefined;
  const nextLine = lines[loc.startLine] ?? undefined;
  const width = String(loc.startLine + (nextLine !== undefined ? 1 : 0)).length;
  const gutter = " ".repeat(width);
  const markerStart = Math.max(0, loc.startColumn - 1);
  const markerWidth = Math.max(
    1,
    loc.endLine === loc.startLine
      ? loc.endColumn - loc.startColumn + 1
      : targetLine.length - loc.startColumn + 1,
  );
  const marker = `${" ".repeat(markerStart)}${"^".repeat(markerWidth)}`;

  const snippet: string[] = [`${gutter} |`];
  if (previousLine !== undefined) {
    snippet.push(
      `${String(loc.startLine - 1).padStart(width)} | ${previousLine}`,
    );
  }
  snippet.push(`${String(loc.startLine).padStart(width)} | ${targetLine}`);
  snippet.push(`${gutter} | ${marker}`);
  if (nextLine !== undefined) {
    snippet.push(`${String(loc.startLine + 1).padStart(width)} | ${nextLine}`);
  }
  return snippet.join("\n");
}

export function formatBridgeError(
  err: unknown,
  options: FormatBridgeErrorOptions = {},
): string {
  const message = getMessage(err);
  const loc = getBridgeLoc(err);
  if (!loc) {
    return `Bridge Execution Error: ${message}`;
  }

  const filename = getBridgeFilename(err, options);
  const source = getBridgeSource(err, options);
  const header = `Bridge Execution Error: ${message}\n  --> ${filename}:${loc.startLine}:${loc.startColumn}`;

  if (!source) {
    return header;
  }

  return `${header}\n${renderSnippet(source, loc)}`;
}
