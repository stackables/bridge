import { Discovery } from "./discovery.ts";
import type {
  AggregatedSchemaInterface,
  OperationObservation,
  Stats,
} from "./model.ts";
import { aggregatedSchemaToSDL } from "./schema-to-sdl.ts";
import {
  addObservedOperationToSchema,
  parseOperation,
} from "./stats-to-schema.ts";

export class GraphQLSchemaObserver {
  private readonly inputStatsByOperation = new Map<string, Stats>();
  private readonly inputSamplesByOperation = new Map<string, number>();
  private readonly outputStatsByOperation = new Map<string, Stats>();
  private readonly outputSamplesByOperation = new Map<string, number>();

  private recordInput(operation: string, input: Record<string, unknown>): void {
    const inputStats = this.inputStatsByOperation.get(operation) ?? {};
    const nextInputSample =
      (this.inputSamplesByOperation.get(operation) ?? 0) + 1;
    new Discovery(inputStats).update(input, nextInputSample);
    this.inputStatsByOperation.set(operation, inputStats);
    this.inputSamplesByOperation.set(operation, nextInputSample);
  }

  private recordOutput(operation: string, output: unknown): void {
    const outputStats = this.outputStatsByOperation.get(operation) ?? {};
    const nextOutputSample =
      (this.outputSamplesByOperation.get(operation) ?? 0) + 1;
    new Discovery(outputStats).update({ result: output }, nextOutputSample);
    this.outputStatsByOperation.set(operation, outputStats);
    this.outputSamplesByOperation.set(operation, nextOutputSample);
  }

  add(observation: OperationObservation): void {
    const { operation, input = {}, output } = observation;
    parseOperation(operation);

    this.recordInput(operation, input);
    this.recordOutput(operation, output);
  }

  addInput(operation: string, input: Record<string, unknown>): void {
    parseOperation(operation);
    this.recordInput(operation, input);
  }

  addOutput(operation: string, output: unknown): void {
    parseOperation(operation);
    this.recordOutput(operation, output);
  }

  toSchema(): AggregatedSchemaInterface {
    const schema: AggregatedSchemaInterface = { types: {} };
    const operations = new Set<string>([
      ...this.inputStatsByOperation.keys(),
      ...this.outputStatsByOperation.keys(),
    ]);

    for (const operation of [...operations].sort((left, right) =>
      left.localeCompare(right),
    )) {
      addObservedOperationToSchema(
        schema,
        operation,
        this.inputStatsByOperation.get(operation) ?? {},
        this.outputStatsByOperation.get(operation) ?? {},
      );
    }

    return schema;
  }

  toSDL(): string {
    return aggregatedSchemaToSDL(this.toSchema());
  }
}

export function observedDataToSchema(
  observations: Iterable<OperationObservation>,
): AggregatedSchemaInterface {
  const builder = new GraphQLSchemaObserver();
  for (const observation of observations) {
    builder.add(observation);
  }
  return builder.toSchema();
}

export function observedDataToSDL(
  observations: Iterable<OperationObservation>,
): string {
  return aggregatedSchemaToSDL(observedDataToSchema(observations));
}
