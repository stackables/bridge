import type { ScalarFieldType, Stats, StatsValue } from "./model.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inferScalarType(value: unknown): ScalarFieldType {
  if (typeof value === "string") {
    return "String";
  }
  if (typeof value === "boolean") {
    return "Boolean";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "Int" : "Float";
  }
  if (typeof value === "bigint" || value instanceof Date) {
    return "String";
  }
  return "JSON";
}

function mergeValueType(
  current: StatsValue["type"] | undefined,
  next: StatsValue["type"],
): StatsValue["type"] {
  if (current === undefined || current === "unknown") {
    return next;
  }
  if (next === "unknown" || current === next) {
    return current;
  }
  if (
    (current === "Int" && next === "Float") ||
    (current === "Float" && next === "Int")
  ) {
    return "Float";
  }
  return "JSON";
}

export class Discovery {
  private currentSampleIndex = 0;

  constructor(private readonly stats: Stats) {}

  private initialNullable(insideArray: boolean): boolean {
    return !insideArray && this.currentSampleIndex > 1;
  }

  private ensure(
    lastUpdated: string,
    key: string,
    ref: Stats,
    create: StatsValue,
    update: Partial<StatsValue>,
  ) {
    if (ref[key] === undefined) {
      ref[key] = create;
    } else {
      ref[key] = {
        ...ref[key],
        ...update,
      };
    }

    ref[key].lastUpdated = lastUpdated;
  }

  private updateValue(
    lastUpdated: string,
    key: string,
    value: unknown,
    path: string[] = [],
    insideArray = false,
  ) {
    if (value === null || value === undefined) {
      return;
    }

    let ref = this.stats;
    for (const segment of path) {
      ref = ref[segment]!.children!;
    }

    if (Array.isArray(value)) {
      this.ensure(
        lastUpdated,
        key,
        ref,
        {
          type: "unknown",
          array: true,
          nullable: this.initialNullable(insideArray),
        },
        { array: true },
      );

      for (const [index, item] of value.entries()) {
        this.updateValue(`${lastUpdated}~${index}`, key, item, path, true);
        this.ensureNullables(`${lastUpdated}~${index}`, ref[key]);
        this.clearIteration(ref[key]);
      }
      return;
    }

    if (isPlainObject(value)) {
      const existing = ref[key];
      const type = mergeValueType(existing?.type, "object");

      if (type === "JSON") {
        this.ensure(
          lastUpdated,
          key,
          ref,
          {
            type: "JSON",
            array: false,
            nullable: this.initialNullable(insideArray),
          },
          { type: "JSON", children: undefined },
        );
        return;
      }

      this.ensure(
        lastUpdated,
        key,
        ref,
        {
          type: "object",
          array: false,
          children: {},
          nullable: this.initialNullable(insideArray),
        },
        { type: "object", children: existing?.children ?? {} },
      );

      for (const [childKey, childValue] of Object.entries(value)) {
        this.updateValue(
          lastUpdated,
          childKey,
          childValue,
          [...path, key],
          insideArray,
        );
      }
      return;
    }

    const type = mergeValueType(ref[key]?.type, inferScalarType(value));
    this.ensure(
      lastUpdated,
      key,
      ref,
      {
        type,
        array: false,
        nullable: this.initialNullable(insideArray),
      },
      { type, children: type === "JSON" ? undefined : ref[key]?.children },
    );
  }

  private clearIteration(ref: StatsValue) {
    ref.lastUpdated = ref.lastUpdated?.split("~").shift();

    if (ref.children) {
      for (const value of Object.values(ref.children)) {
        this.clearIteration(value);
      }
    }
  }

  private ensureNullables(lastUpdated: string, ref: StatsValue) {
    if (!ref.nullable) {
      ref.nullable = ref.lastUpdated !== lastUpdated;
    }

    if (!ref.nullable && ref.children && !ref.array) {
      for (const value of Object.values(ref.children)) {
        this.ensureNullables(lastUpdated, value);
      }
    }
  }

  update(obj: Record<string, unknown>, sampleIndex: number) {
    this.currentSampleIndex = sampleIndex;
    const lastUpdated = `${sampleIndex}`;

    for (const [key, value] of Object.entries(obj)) {
      this.updateValue(lastUpdated, key, value);
    }

    for (const value of Object.values(this.stats)) {
      this.ensureNullables(lastUpdated, value);
    }
  }
}
