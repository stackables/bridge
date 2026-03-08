import type { Bridge, NodeRef, Wire } from "./types.ts";
import type { Trunk } from "./tree-types.ts";
import { trunkDependsOnElement } from "./scheduleTools.ts";
import { coerceConstant } from "./tree-utils.ts";

export type TraversalBranchSite = {
  siteIndex: number;
  stableKey: string;
  targetPath: string[];
  repeatable: boolean;
  possibleOutcomes: string[];
};

export type TraversalIdPlan = {
  traversalId: string;
  operation: string;
  sites: Array<{
    siteIndex: number;
    targetPath: string[];
    stableKey: string;
    repeatable: boolean;
    observedOutcomes: string[];
  }>;
};

export type TraversalPlanExplanation = {
  traversalId: string;
  operation: string;
  sites: Array<{
    siteIndex: number;
    path: string;
    repeatable: boolean;
    outcomes: Array<{
      raw: string;
      summary: string;
    }>;
  }>;
};

type TraversalSiteCatalog = {
  sites: TraversalBranchSite[];
  byWire: WeakMap<Wire, TraversalBranchSite>;
  byStableKey: Map<string, TraversalBranchSite>;
};

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const FNV_MASK_64 = 0xffffffffffffffffn;

export function buildTraversalSiteCatalog(
  bridge?: Bridge,
): TraversalSiteCatalog {
  const byWire = new WeakMap<Wire, TraversalBranchSite>();
  const byStableKey = new Map<string, TraversalBranchSite>();
  const sites: TraversalBranchSite[] = [];

  if (!bridge) {
    return { sites, byWire, byStableKey };
  }

  const overdefinedTargetCounts = new Map<string, number>();
  for (const wire of bridge.wires) {
    const targetKey = stableTargetKey(wire);
    overdefinedTargetCounts.set(
      targetKey,
      (overdefinedTargetCounts.get(targetKey) ?? 0) + 1,
    );
  }

  for (const wire of bridge.wires) {
    const stableKey = stableWireKey(wire);
    let site = byStableKey.get(stableKey);
    if (!site) {
      const overdefinedTargetCount =
        overdefinedTargetCounts.get(stableTargetKey(wire)) ?? 0;
      if (isInformativeWire(wire, overdefinedTargetCount)) {
        site = {
          siteIndex: sites.length,
          stableKey,
          targetPath: [...wire.to.path],
          repeatable: isRepeatableWire(bridge, wire),
          possibleOutcomes: possibleTraversalOutcomesForWire(
            wire,
            overdefinedTargetCount,
          ),
        };
        sites.push(site);
      }
      if (site) {
        byStableKey.set(stableKey, site);
      }
    }
    if (site) {
      byWire.set(wire, site);
    }
  }

  return { sites, byWire, byStableKey };
}

export function enumerateTraversalIds(
  bridge: Bridge,
  operation = `${bridge.type}.${bridge.field}`,
): TraversalIdPlan[] {
  const catalog = buildTraversalSiteCatalog(bridge);
  if (catalog.sites.length === 0) {
    return [
      {
        traversalId: traversalIdFromObservedSites(operation, []),
        operation,
        sites: [],
      },
    ];
  }

  const plans: TraversalIdPlan[] = [];
  const selection: TraversalIdPlan["sites"] = [];

  function visit(siteIndex: number): void {
    if (siteIndex >= catalog.sites.length) {
      plans.push({
        traversalId: traversalIdFromObservedSites(operation, selection),
        operation,
        sites: selection.map((site) => ({
          siteIndex: site.siteIndex,
          targetPath: [...site.targetPath],
          stableKey: site.stableKey,
          repeatable: site.repeatable,
          observedOutcomes: [...site.observedOutcomes],
        })),
      });
      return;
    }

    const site = catalog.sites[siteIndex]!;
    const observedOutcomeSets = site.repeatable
      ? nonEmptySubsets(site.possibleOutcomes)
      : site.possibleOutcomes.map((outcome) => [outcome]);

    for (const observedOutcomes of observedOutcomeSets) {
      selection.push({
        siteIndex: site.siteIndex,
        targetPath: site.targetPath,
        stableKey: site.stableKey,
        repeatable: site.repeatable,
        observedOutcomes,
      });
      visit(siteIndex + 1);
      selection.pop();
    }
  }

  visit(0);
  return plans;
}

export function traversalIdFromObservedSites(
  operation: string,
  sites: Array<{ siteIndex: number; observedOutcomes: string[] }>,
): string {
  const traversalBody = `${operation}:${sites
    .slice()
    .sort((left, right) => left.siteIndex - right.siteIndex)
    .flatMap((site) =>
      [...site.observedOutcomes]
        .sort()
        .map((outcome) => `${site.siteIndex}:${outcome}`),
    )
    .join("|")}`;
  return traversalFingerprint("path", traversalBody);
}

export function explainTraversalPlan(
  plan: TraversalIdPlan,
): TraversalPlanExplanation {
  return {
    traversalId: plan.traversalId,
    operation: plan.operation,
    sites: plan.sites
      .slice()
      .sort((left, right) => left.siteIndex - right.siteIndex)
      .map((site) => ({
        siteIndex: site.siteIndex,
        path: site.targetPath.join(".") || "<root>",
        repeatable: site.repeatable,
        outcomes: [...site.observedOutcomes]
          .sort()
          .map((raw) => ({ raw, summary: summarizeTraversalOutcome(raw) })),
      })),
  };
}

export function traversalFingerprint(prefix: string, value: string): string {
  return `${prefix}_${fnv1a64(value)}`;
}

function fnv1a64(value: string): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * FNV_PRIME_64) & FNV_MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

function summarizeTraversalOutcome(outcome: string): string {
  return outcome
    .split(">")
    .map((part) => humanizeTraversalSegment(part))
    .join(" -> ");
}

function humanizeTraversalSegment(segment: string): string {
  if (segment === "source:from") return "read source ref";
  if (segment === "source:from:safe-error") return "safe source error";
  if (segment === "source:and:left-false") return "AND left side false";
  if (segment === "source:and:left-true") return "AND left side true";
  if (segment === "source:or:left-true") return "OR left side true";
  if (segment === "source:or:left-false") return "OR left side false";
  if (segment === "return") return "return value";
  if (segment === "fallthrough:nullish") return "fall through on nullish";
  if (segment === "catch:ref") return "catch via ref";
  if (segment === "catch:value") return "catch via literal";

  if (segment.startsWith("catch:control:")) {
    return `catch control ${segment.slice("catch:control:".length)}`;
  }

  if (segment.startsWith("source:cond:")) {
    const [, , branch, mode] = segment.split(":");
    return `condition ${branch} -> ${mode === "ref" ? "use ref" : mode === "value" ? "use literal" : "undefined"}`;
  }

  if (segment.startsWith("source:and:right:")) {
    const mode = segment.slice("source:and:right:".length);
    return `AND right side via ${mode === "ref" ? "ref" : "literal"}`;
  }

  if (segment.startsWith("source:or:right:")) {
    const mode = segment.slice("source:or:right:".length);
    return `OR right side via ${mode === "ref" ? "ref" : "literal"}`;
  }

  if (segment.startsWith("fallback:")) {
    const [, rawIndex, gate, mode, controlKind] = segment.split(":");
    const gateLabel = gate === "nullish" ? "??" : "||";
    const indexLabel = Number(rawIndex) + 1;
    if (mode === "ref") return `${gateLabel} fallback ${indexLabel} via ref`;
    if (mode === "value") return `${gateLabel} fallback ${indexLabel} via literal`;
    if (mode === "control") {
      return `${gateLabel} fallback ${indexLabel} via control ${controlKind}`;
    }
  }

  return segment.replaceAll(":", " ");
}

export function stableWireKey(wire: Wire): string {
  const base = `${stableLocKey(wire.loc)}=>${stableNodeRefKey(wire.to)}`;

  if ("value" in wire) {
    return `${base}|value:${JSON.stringify(wire.value)}`;
  }

  if ("from" in wire) {
    return `${base}|from:${stableNodeRefKey(wire.from)}|safe:${wire.safe ? 1 : 0}|spread:${wire.spread ? 1 : 0}|fallbacks:${stableFallbackKey(wire.fallbacks)}|catch:${stableCatchKey(wire)}`;
  }

  if ("cond" in wire) {
    return `${base}|cond:${stableNodeRefKey(wire.cond)}|then:${wire.thenRef ? `ref:${stableNodeRefKey(wire.thenRef)}` : `value:${JSON.stringify(wire.thenValue)}`}|else:${wire.elseRef ? `ref:${stableNodeRefKey(wire.elseRef)}` : `value:${JSON.stringify(wire.elseValue)}`}|fallbacks:${stableFallbackKey(wire.fallbacks)}|catch:${stableCatchKey(wire)}`;
  }

  if ("condAnd" in wire) {
    return `${base}|and:${stableNodeRefKey(wire.condAnd.leftRef)}|right:${wire.condAnd.rightRef ? `ref:${stableNodeRefKey(wire.condAnd.rightRef)}` : `value:${JSON.stringify(wire.condAnd.rightValue)}`}|fallbacks:${stableFallbackKey(wire.fallbacks)}|catch:${stableCatchKey(wire)}`;
  }

  return `${base}|or:${stableNodeRefKey(wire.condOr.leftRef)}|right:${wire.condOr.rightRef ? `ref:${stableNodeRefKey(wire.condOr.rightRef)}` : `value:${JSON.stringify(wire.condOr.rightValue)}`}|fallbacks:${stableFallbackKey(wire.fallbacks)}|catch:${stableCatchKey(wire)}`;
}

function stableTargetKey(wire: Wire): string {
  return stableNodeRefKey(wire.to);
}

function stableNodeRefKey(ref: NodeRef): string {
  return [
    ref.module,
    ref.type,
    ref.field,
    ref.instance ?? "",
    ref.element ? "element" : "",
    ref.elementDepth ?? "",
    ref.rootSafe ? "rootSafe" : "",
    ref.path.join("."),
    ref.pathSafe?.map((value) => (value ? "1" : "0")).join("") ?? "",
  ].join("|");
}

function stableLocKey(
  loc:
    | {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
      }
    | undefined,
): string {
  if (!loc) return "-";
  return `${loc.startLine}:${loc.startColumn}-${loc.endLine}:${loc.endColumn}`;
}

function stableFallbackKey(
  fallbacks:
    | {
        type: string;
        ref?: NodeRef;
        value?: string;
        control?: { kind: string };
      }[]
    | undefined,
): string {
  if (!fallbacks?.length) return "-";
  return fallbacks
    .map((fallback, index) => {
      if (fallback.ref) {
        return `${index}:${fallback.type}:ref:${stableNodeRefKey(fallback.ref)}`;
      }
      if (fallback.value !== undefined) {
        return `${index}:${fallback.type}:value:${JSON.stringify(fallback.value)}`;
      }
      if (fallback.control) {
        return `${index}:${fallback.type}:control:${fallback.control.kind}`;
      }
      return `${index}:${fallback.type}:unknown`;
    })
    .join(",");
}

function stableCatchKey(wire: Exclude<Wire, { value: string }>): string {
  if (wire.catchFallbackRef) {
    return `ref:${stableNodeRefKey(wire.catchFallbackRef)}`;
  }
  if (wire.catchFallback != null) {
    return `value:${JSON.stringify(wire.catchFallback)}`;
  }
  if (wire.catchControl) {
    return `control:${wire.catchControl.kind}`;
  }
  return "-";
}

function isInformativeWire(
  wire: Wire,
  overdefinedTargetCount: number,
): boolean {
  if (overdefinedTargetCount > 1) return true;
  if ("value" in wire) return false;
  if ("cond" in wire || "condAnd" in wire || "condOr" in wire) return true;
  if (wire.safe) return true;
  if (wire.fallbacks?.length) return true;
  if (
    wire.catchFallback != null ||
    wire.catchFallbackRef ||
    wire.catchControl
  ) {
    return true;
  }
  return false;
}

function isRepeatableWire(bridge: Bridge, wire: Wire): boolean {
  if (wire.to.element) return true;

  const targetTrunk: Trunk = {
    module: wire.to.module,
    type: wire.to.type,
    field: wire.to.field,
    instance: wire.to.instance,
  };
  if (trunkDependsOnElement(bridge, targetTrunk)) return true;

  for (const ref of refsInWire(wire)) {
    if (ref.element || (ref.elementDepth ?? 0) > 0) return true;
    const sourceTrunk: Trunk = {
      module: ref.module,
      type: ref.type,
      field: ref.field,
      instance: ref.instance,
    };
    if (trunkDependsOnElement(bridge, sourceTrunk)) return true;
  }

  return false;
}

function refsInWire(wire: Wire): NodeRef[] {
  const refs: NodeRef[] = [];

  if ("from" in wire) {
    refs.push(wire.from);
    for (const fallback of wire.fallbacks ?? []) {
      if (fallback.ref) refs.push(fallback.ref);
    }
    if (wire.catchFallbackRef) refs.push(wire.catchFallbackRef);
    return refs;
  }

  if ("cond" in wire) {
    refs.push(wire.cond);
    if (wire.thenRef) refs.push(wire.thenRef);
    if (wire.elseRef) refs.push(wire.elseRef);
    for (const fallback of wire.fallbacks ?? []) {
      if (fallback.ref) refs.push(fallback.ref);
    }
    if (wire.catchFallbackRef) refs.push(wire.catchFallbackRef);
    return refs;
  }

  if ("condAnd" in wire) {
    refs.push(wire.condAnd.leftRef);
    if (wire.condAnd.rightRef) refs.push(wire.condAnd.rightRef);
    for (const fallback of wire.fallbacks ?? []) {
      if (fallback.ref) refs.push(fallback.ref);
    }
    if (wire.catchFallbackRef) refs.push(wire.catchFallbackRef);
    return refs;
  }

  if ("condOr" in wire) {
    refs.push(wire.condOr.leftRef);
    if (wire.condOr.rightRef) refs.push(wire.condOr.rightRef);
    for (const fallback of wire.fallbacks ?? []) {
      if (fallback.ref) refs.push(fallback.ref);
    }
    if (wire.catchFallbackRef) refs.push(wire.catchFallbackRef);
  }

  return refs;
}

type ValueState = "truthy" | "falsy" | "nullish";

type PendingState = {
  parts: string[];
  state: ValueState;
};

function possibleTraversalOutcomesForWire(
  wire: Wire,
  overdefinedTargetCount: number,
): string[] {
  const outcomes = new Set<string>();

  if ("value" in wire) {
    outcomes.add(
      terminalOutcome(
        ["constant"],
        categoryOfValue(coerceConstant(wire.value)),
      ),
    );
    return [...outcomes].sort();
  }

  for (const pending of possibleInitialStatesForWire(wire)) {
    for (const outcome of finalizeFallbackSequence(pending, wire.fallbacks)) {
      outcomes.add(outcome);
    }
  }

  if (wire.catchFallbackRef) {
    outcomes.add("catch:ref>return");
  }
  if (wire.catchFallback != null) {
    outcomes.add("catch:value>return");
  }
  if (wire.catchControl) {
    outcomes.add(`catch:control:${wire.catchControl.kind}>return`);
  }

  if (
    overdefinedTargetCount > 1 &&
    ![...outcomes].some((outcome) => outcome.endsWith("fallthrough:nullish"))
  ) {
    for (const pending of possibleInitialStatesForWire(wire)) {
      outcomes.add(terminalOutcome(pending.parts, "nullish"));
    }
  }

  return [...outcomes].sort();
}

function possibleInitialStatesForWire(
  wire: Exclude<Wire, { value: string }>,
): PendingState[] {
  if ("from" in wire) {
    const states: PendingState[] = [
      { parts: ["source:from"], state: "truthy" },
      { parts: ["source:from"], state: "falsy" },
      { parts: ["source:from"], state: "nullish" },
    ];
    if (wire.safe) {
      states.push({ parts: ["source:from:safe-error"], state: "nullish" });
    }
    return states;
  }

  if ("cond" in wire) {
    return [
      ...statesForBranch("source:cond:then", wire.thenRef, wire.thenValue),
      ...statesForBranch("source:cond:else", wire.elseRef, wire.elseValue),
    ];
  }

  if ("condAnd" in wire) {
    return [
      { parts: ["source:and:left-false"], state: "falsy" },
      ...statesForBranch(
        "source:and:right",
        wire.condAnd.rightRef,
        wire.condAnd.rightValue,
        true,
      ),
      { parts: ["source:and:left-true"], state: "truthy" },
    ];
  }

  return [
    { parts: ["source:or:left-true"], state: "truthy" },
    ...statesForBranch(
      "source:or:right",
      wire.condOr.rightRef,
      wire.condOr.rightValue,
      true,
    ),
    { parts: ["source:or:left-false"], state: "falsy" },
  ];
}

function statesForBranch(
  prefix: string,
  ref: NodeRef | undefined,
  value: string | undefined,
  booleanised = false,
): PendingState[] {
  if (ref) {
    return booleanised
      ? [
          { parts: [`${prefix}:ref`], state: "truthy" },
          { parts: [`${prefix}:ref`], state: "falsy" },
        ]
      : [
          { parts: [`${prefix}:ref`], state: "truthy" },
          { parts: [`${prefix}:ref`], state: "falsy" },
          { parts: [`${prefix}:ref`], state: "nullish" },
        ];
  }

  if (value !== undefined) {
    const coerced = booleanised
      ? Boolean(coerceConstant(value))
      : coerceConstant(value);
    return [
      {
        parts: [`${prefix}:value`],
        state: categoryOfValue(coerced),
      },
    ];
  }

  return [{ parts: [`${prefix}:undefined`], state: "nullish" }];
}

function finalizeFallbackSequence(
  initial: PendingState,
  fallbacks: Exclude<Wire, { value: string }>["fallbacks"] | undefined,
): string[] {
  let states: PendingState[] = [initial];

  for (const [index, fallback] of (fallbacks ?? []).entries()) {
    const nextStates: PendingState[] = [];

    for (const state of states) {
      if (!fallbackGateOpens(state.state, fallback.type)) {
        nextStates.push(state);
        continue;
      }

      if (fallback.control) {
        nextStates.push({
          parts: [
            ...state.parts,
            `fallback:${index}:${fallback.type}:control:${fallback.control.kind}`,
          ],
          state: "truthy",
        });
        continue;
      }

      if (fallback.ref) {
        nextStates.push(
          {
            parts: [...state.parts, `fallback:${index}:${fallback.type}:ref`],
            state: "truthy",
          },
          {
            parts: [...state.parts, `fallback:${index}:${fallback.type}:ref`],
            state: "falsy",
          },
          {
            parts: [...state.parts, `fallback:${index}:${fallback.type}:ref`],
            state: "nullish",
          },
        );
        continue;
      }

      if (fallback.value !== undefined) {
        nextStates.push({
          parts: [...state.parts, `fallback:${index}:${fallback.type}:value`],
          state: categoryOfValue(coerceConstant(fallback.value)),
        });
        continue;
      }
    }

    states = nextStates;
  }

  return states.map((state) => terminalOutcome(state.parts, state.state));
}

function fallbackGateOpens(state: ValueState, type: string): boolean {
  if (type === "nullish") return state === "nullish";
  return state === "falsy" || state === "nullish";
}

function terminalOutcome(parts: string[], state: ValueState): string {
  return [
    ...parts,
    state === "nullish" ? "fallthrough:nullish" : "return",
  ].join(">");
}

function categoryOfValue(value: unknown): ValueState {
  if (value == null) return "nullish";
  return value ? "truthy" : "falsy";
}

function nonEmptySubsets<T>(items: readonly T[]): T[][] {
  const subsets: T[][] = [];
  const limit = 1 << items.length;
  for (let mask = 1; mask < limit; mask++) {
    const subset: T[] = [];
    for (let index = 0; index < items.length; index++) {
      if (mask & (1 << index)) {
        subset.push(items[index]!);
      }
    }
    subsets.push(subset);
  }
  return subsets;
}
