import type { SourceLocation, TraversalEntry } from "@stackables/bridge";

function comparePosition(
  lineA: number,
  columnA: number,
  lineB: number,
  columnB: number,
): number {
  if (lineA !== lineB) {
    return lineA - lineB;
  }
  return columnA - columnB;
}

function containsLocation(
  outer: SourceLocation,
  inner: SourceLocation,
): boolean {
  return (
    comparePosition(
      outer.startLine,
      outer.startColumn,
      inner.startLine,
      inner.startColumn,
    ) <= 0 &&
    comparePosition(
      outer.endLine,
      outer.endColumn,
      inner.endLine,
      inner.endColumn,
    ) >= 0
  );
}

function locationKey(loc: SourceLocation): string {
  return `${loc.startLine}:${loc.startColumn}:${loc.endLine}:${loc.endColumn}`;
}

function isSupersededByActiveLocation(
  loc: SourceLocation,
  activeLocations: SourceLocation[],
): boolean {
  return activeLocations.some((activeLoc) => containsLocation(loc, activeLoc));
}

export function collectInactiveTraversalLocations(
  manifest: TraversalEntry[],
  activeIds: ReadonlySet<string>,
): SourceLocation[] {
  const wireGroups = new Map<number, TraversalEntry[]>();
  for (const entry of manifest) {
    let group = wireGroups.get(entry.wireIndex);
    if (!group) {
      group = [];
      wireGroups.set(entry.wireIndex, group);
    }
    group.push(entry);
  }

  const activeLocations = manifest.flatMap((entry) =>
    activeIds.has(entry.id) && entry.loc ? [entry.loc] : [],
  );

  const seen = new Set<string>();
  const result: SourceLocation[] = [];

  for (const entries of wireGroups.values()) {
    const allDead = entries.every((entry) => !activeIds.has(entry.id));

    if (allDead) {
      const wireLoc = entries[0]?.wireLoc ?? entries[0]?.loc;
      if (!wireLoc) {
        continue;
      }
      if (isSupersededByActiveLocation(wireLoc, activeLocations)) {
        continue;
      }

      const key = locationKey(wireLoc);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(wireLoc);
      }
      continue;
    }

    for (const entry of entries) {
      if (activeIds.has(entry.id) || !entry.loc) {
        continue;
      }
      if (isSupersededByActiveLocation(entry.loc, activeLocations)) {
        continue;
      }

      const key = locationKey(entry.loc);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(entry.loc);
    }
  }

  return result;
}
