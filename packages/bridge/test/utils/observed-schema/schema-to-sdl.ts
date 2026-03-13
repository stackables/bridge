import type { AggregatedSchemaInterface, ObjectField } from "./model.ts";

function renderTypeReference(field: ObjectField): string {
  let rendered = `${field.type}`;
  if (field.array) {
    rendered = `[${rendered}!]`;
  }
  if (field.required) {
    rendered += "!";
  }
  return rendered;
}

export function aggregatedSchemaToSDL(
  schema: AggregatedSchemaInterface,
): string {
  const usesJsonScalar = Object.values(schema.types).some((typeDef) =>
    typeDef.fields.some((field) => {
      if (field.type === "JSON") {
        return true;
      }
      return field.args?.some((arg) => arg.type === "JSON") ?? false;
    }),
  );

  const typeNames = Object.keys(schema.types).sort((left, right) => {
    const rank = (name: string) => {
      if (name === "Query") return 0;
      if (name === "Mutation") return 1;
      return 2;
    };
    return rank(left) - rank(right) || left.localeCompare(right);
  });

  const blocks = typeNames.map((typeName) => {
    const typeDef = schema.types[typeName];
    const kind = typeDef.type === "INPUT" ? "input" : "type";
    const fields = typeDef.fields.map((field) => {
      const args = field.args?.length
        ? `(${field.args
            .map((arg) => `${arg.name}: ${renderTypeReference(arg)}`)
            .join(", ")})`
        : "";
      return `  ${field.name}${args}: ${renderTypeReference(field)}`;
    });
    return `${kind} ${typeDef.name} {\n${fields.join("\n")}\n}`;
  });

  if (usesJsonScalar) {
    blocks.unshift("scalar JSON");
  }

  return `${blocks.join("\n\n")}\n`;
}
