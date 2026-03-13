import type {
  AggregatedSchemaInterface,
  ObjectField,
  RootOperation,
  ScalarFieldType,
  SchemaObjectType,
  Stats,
  StatsValue,
} from "./model.ts";

export function parseOperation(operation: string): {
  rootType: RootOperation;
  fieldName: string;
} {
  const [rootType, fieldName, ...rest] = operation.split(".");
  if (!rootType || fieldName === undefined || rest.length > 0) {
    throw new Error(
      `Operation must be in the form Type.field, got ${operation}`,
    );
  }

  return { rootType, fieldName };
}

function toTypeName(...parts: string[]): string {
  const joined = parts
    .flatMap((part) =>
      part
        .split(/[^A-Za-z0-9]+/)
        .map((token) => token.trim())
        .filter(Boolean),
    )
    .map((token) => token[0]!.toUpperCase() + token.slice(1))
    .join("");

  if (joined.length === 0) {
    return "ObservedType";
  }

  return /^[_A-Za-z]/.test(joined) ? joined : `Observed${joined}`;
}

function createTypeRef(
  schema: AggregatedSchemaInterface,
  value: StatsValue,
  typeName: string,
  objectType: SchemaObjectType,
): string | ScalarFieldType {
  if (value.type === "object") {
    const resolvedTypeName = toTypeName(typeName);
    if (!schema.types[resolvedTypeName]) {
      schema.types[resolvedTypeName] = {
        name: resolvedTypeName,
        type: objectType,
        fields: [],
      };
      schema.types[resolvedTypeName].fields = createFields(
        schema,
        value.children ?? {},
        resolvedTypeName,
        objectType,
      );
    }
    return resolvedTypeName;
  }

  if (value.type === "unknown") {
    return "JSON";
  }

  return value.type;
}

export function createFields(
  schema: AggregatedSchemaInterface,
  stats: Stats,
  parentTypeName: string,
  objectType: SchemaObjectType,
): ObjectField[] {
  return Object.entries(stats)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      name,
      type: createTypeRef(
        schema,
        value,
        `${parentTypeName}_${name}${objectType === "INPUT" ? "_input" : ""}`,
        objectType,
      ),
      required: !value.nullable,
      array: value.array,
    }));
}

export function addObservedOperationToSchema(
  schema: AggregatedSchemaInterface,
  operation: string,
  inputStats: Stats,
  outputStats: Stats,
): void {
  const { rootType, fieldName } = parseOperation(operation);
  const outputValue = outputStats.result;

  if (!outputValue) {
    throw new Error(
      `Cannot infer output schema for ${operation} without an observed non-null result`,
    );
  }

  if (!schema.types[rootType]) {
    schema.types[rootType] = {
      name: rootType,
      type: "OUTPUT",
      fields: [],
    };
  }

  schema.types[rootType].fields.push({
    name: fieldName,
    args: createFields(schema, inputStats, `${rootType}_${fieldName}`, "INPUT"),
    type: createTypeRef(
      schema,
      outputValue,
      `${rootType}_${fieldName}_result`,
      "OUTPUT",
    ),
    required: !outputValue.nullable,
    array: outputValue.array,
  });
}
