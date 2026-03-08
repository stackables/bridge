import type { Bridge, Wire } from "./types.ts";
import {
  buildTraversalSiteCatalog,
  stableWireKey,
  traversalIdFromObservedSites,
} from "./traversal-space.ts";

type TraversalRequest = {
  operation: string;
};

export class TraversalIdCollector {
  private readonly catalog;
  private readonly outcomes = new Map<number, Set<string>>();
  private request?: TraversalRequest;

  constructor(bridge?: Bridge) {
    this.catalog = buildTraversalSiteCatalog(bridge);
  }

  begin(request: TraversalRequest): void {
    this.request = { operation: request.operation };
    this.outcomes.clear();
  }

  record(wire: Wire, outcome: string): void {
    const site =
      this.catalog.byWire.get(wire) ??
      this.catalog.byStableKey.get(stableWireKey(wire));
    if (!site) return;
    let wireOutcomes = this.outcomes.get(site.siteIndex);
    if (!wireOutcomes) {
      wireOutcomes = new Set<string>();
      this.outcomes.set(site.siteIndex, wireOutcomes);
    }
    wireOutcomes.add(outcome);
  }

  traversalId(): string | undefined {
    if (!this.request) return undefined;
    return traversalIdFromObservedSites(
      this.request.operation,
      [...this.outcomes.entries()].map(([siteIndex, outcomes]) => ({
        siteIndex,
        observedOutcomes: [...outcomes],
      })),
    );
  }
}
