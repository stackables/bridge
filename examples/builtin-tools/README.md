# Built-in Tools Example

Demonstrates the built-in `std` namespace tools (`std.upperCase`, `std.lowerCase`, `std.findObject`) without any external APIs.

## Run

```bash
npx tsx examples/builtin-tools/server.ts
```

## Queries

```graphql
# String formatting
{ format(text: "Hello World") { original upper lower } }

# Find an employee by department
{ findEmployee(department: "Engineering") { id name department } }
```
