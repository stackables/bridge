export type SchemaObjectType = "INPUT" | "OUTPUT";

export type ScalarFieldType =
  | "String"
  | "Int"
  | "Float"
  | "Boolean"
  | "ID"
  | "JSON";

export interface ObjectField<E = string> {
  name: string;
  description?: string | null;
  type: E | ScalarFieldType;
  required: boolean;
  array: boolean;
}

export interface FieldWithArgs<E = string> extends ObjectField<E> {
  args?: ObjectField<E>[] | null;
}

export interface ComplexObject<E = string> {
  name: string;
  description?: string | null;
  type: SchemaObjectType;
  fields: FieldWithArgs<E>[];
}

export interface AggregatedSchemaInterface<E = string> {
  types: Record<string, ComplexObject<E>>;
}

export interface StatsValue {
  type: ScalarFieldType | "object" | "unknown";
  array: boolean;
  nullable: boolean;
  children?: Stats;
  lastUpdated?: string;
}

export interface Stats {
  [key: string]: StatsValue;
}

export type RootOperation = string;

export type OperationObservation = {
  operation: string;
  input?: Record<string, unknown>;
  output?: unknown;
};
