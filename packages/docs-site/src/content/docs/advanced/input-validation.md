---
title: Asserting Inputs
description: Asserting Inputs & Preventing Execution
---

In a standard stack, your GraphQL schema acts as the first line of defense. If a variable is marked as required (`String!`), the GraphQL server will reject invalid queries before The Bridge even wakes up.

However, there are times when you need deeper business logic validation before allowing an expensive API call to fire—such as ensuring a string isn't empty, enforcing cross-field rules, or applying complex regex patterns.

Because The Bridge uses a **pull-based** engine, the most efficient way to prevent a tool from executing is to intentionally break the wire going _into_ its inputs, or to evaluate a rule before the graph resolves.

Here are the primary ways to validate inputs and safely halt execution in The Bridge:

## 1. Inline Validation (`throw`)

The cleanest way to validate a direct tool input is to use the explicit `throw` keyword combined with a Falsy Gate (`||`) or Nullish Gate (`??`).

If the validation fails, the engine throws an error _during input resolution_. Because the tool never receives its required parameters, the engine safely aborts that branch, and the HTTP request is never fired.

```bridge
bridge Query.location {
  with geoApi as geo
  with input as i
  with output as o

  # GraphQL might allow an empty string (""), but our API doesn't!
  # The || gate throws immediately, bypassing the geoApi call completely.
  geo.q <- i.city || throw "City name cannot be empty"

  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}

```

## 2. Decoupled Business Rules

Sometimes you need to validate a business rule that isn't directly tied to a specific API parameter (e.g., ensuring a user is over 18 before allowing them to use the endpoint at all). You can handle this using a **Lazy Gate** or an **Eager Force**.

### Option A: The Lazy Gate (Pull Pattern)

You can wrap the entire `input` object in a conditional alias. Downstream wires must pull through this alias, which guarantees the rule is evaluated before the API fires.

```bridge
bridge Query.location {
  with geoApi as geo
  with input as i
  with output as o

  # 1. Create a Gate: If age >= 18, yield the input. Otherwise, yield null.
  # 2. The ?? fallback catches the null and throws!
  alias (i.age >= 18) ? i : null ?? throw "Must be 18 or older" as ageChecked

  # 3. Wire from the gated input.
  geo.q <- ageChecked.city

  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}

```

### Option B: The Eager Force (Push Pattern)

If you prefer not to alias your inputs, you can declare the rule standalone and tell the engine it _must_ evaluate it before returning the GraphQL response using `force`.

```bridge
bridge Query.location {
  with geoApi as geo
  with input as i
  with output as o

  # 1. Declare the business rule using inline boolean logic.
  alias (i.age >= 18) || throw "Must be 18 or older" as ageCheck

  # 2. Force the engine to evaluate the rule eagerly!
  force ageCheck

  # 3. Wire the main API normally.
  geo.q <- i.city
  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}

```

## 3. Custom Validation Tools

If you have complex validation logic—like regex matching, email formatting, or schema parsing—that cannot be handled by simple logic gates, you can pipe the data through a custom validation tool.

```bridge
bridge Query.createUser {
  with userApi as api
  with input as i
  with output as o
  with validateEmail

  # Pipe the input through 'validateEmail' before it reaches 'api.email'
  # If the tool throws an error, execution halts before the API runs.
  api.email <- validateEmail:i.email

  o.id <- api.newUserId
}

```
