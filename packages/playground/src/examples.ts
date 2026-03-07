import type { PlaygroundMode } from "./share";

export type Example = {
  id: string;
  name: string;
  description: string;
  mode?: PlaygroundMode;
  schema: string;
  bridge: string;
  queries: { name: string; query: string }[];
  context: string;
  /** Standalone-mode per-query state (parallel array to queries). */
  standaloneQueries?: {
    operation: string;
    outputFields: string;
    input: Record<string, unknown>;
  }[];
};

export const examples: Example[] = [
  {
    id: "string-transform",
    name: "String Transform",
    description:
      "Use std.str.toUpperCase and std.str.toLowerCase to transform string fields using pipe syntax",
    schema: `
type Query {
  greet(name: String!): Greeting
}

type Greeting {
  message: String
  upper: String
  lower: String
}
    `,
    bridge: `version 1.5

bridge Query.greet {
  with std.str.toUpperCase as uc
  with std.str.toLowerCase as lc
  with input as i
  with output as o

  o.message <- i.name
  o.upper <- uc:i.name
  o.lower <- lc:i.name
}`,
    queries: [
      {
        name: "Query 1",
        query: `{
  greet(name: "Hello Bridge") {
    message
    upper
    lower
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.greet",
        outputFields: "",
        input: { name: "Hello Bridge" },
      },
    ],
    context: `{}`,
  },
  {
    id: "constants",
    name: "Constants",
    description:
      "Hardcode constant values directly in bridge files using the = assignment syntax",
    schema: `
type Query {
  config: Config
}

type Config {
  version: String
  env: String
  label: String
}
    `,
    bridge: `version 1.5

bridge Query.config {
  with output as o

  o.version = "1.0.0"
  o.env = "browser"
  o.label = "Bridge Playground"
}`,
    queries: [
      {
        name: "Query 1",
        query: `{
  config {
    version
    env
    label
  }
}`,
      },
    ],
    context: `{}`,
  },
  {
    id: "context",
    name: "Context",
    description:
      "Access the GraphQL context inside bridge files using 'with context'",
    schema: `
type Query {
  profile: Profile
}

type Profile {
  userId: String
  role: String
}
    `,
    bridge: `version 1.5

bridge Query.profile {
  with context as ctx
  with output as o

  o.userId <- ctx.user.id
  o.role <- ctx.user.role
}`,
    queries: [
      {
        name: "Query 1",
        query: `{
  profile {
    userId
    role
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.profile",
        outputFields: "",
        input: {},
      },
    ],
    context: `{
  "user": {
    "id": "usr_42",
    "role": "admin"
  }
}`,
  },
  {
    id: "http-tool",
    name: "HTTP Tool",
    description:
      "Declare a reusable HTTP tool and wire its response to GraphQL output fields",
    schema: `
type Query {
  location(city: String!): Location
}

type Location {
  lat: Float
  lon: Float
}
    `,
    bridge: `version 1.5

tool geo from std.httpCall {
  .baseUrl = "https://nominatim.openstreetmap.org"
  .path = "/search"
  .format = "json"
  .limit = "1"
}

bridge Query.location {
  with geo
  with input as i
  with output as o

  geo.q <- i.city
  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}`,
    queries: [
      {
        name: "Query 1",
        query: `{
  location(city: "Berlin") {
    lat
    lon
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.location",
        outputFields: "",
        input: { city: "Berlin" },
      },
    ],
    context: `{}`,
  },
  {
    id: "memoized-loop-tools",
    name: "Memoized Fanout",
    description:
      "Reuse repeated loop-scoped tool calls with memoize so duplicate inputs do not trigger duplicate requests",
    schema: `
type CatalogItem {
  id: ID!
  item: String
}

type Query {
  processCatalog: [CatalogItem!]!
}
    `,
    bridge: `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog[] as cat {
    with std.audit as tools memoize

    tools.value <- cat.id
    .id <- cat.id
    .item <- tools.data
  }
}`,
    queries: [
      {
        name: "Query 1",
        query: `{
  processCatalog {
    id
    item
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.processCatalog",
        outputFields: "",
        input: {},
      },
    ],
    context: `{
  "catalog": [
    { "id": "A" },
    { "id": "A" },
    { "id": "B" },
    { "id": "A" }
  ]
}`,
  },
  {
    id: "sbb-train-search",
    name: "SBB Train Search",
    description:
      "Query the Swiss public transport API to find train connections between two stations",
    schema: `
type Station {
  id: ID
  name: String!
}

type StopEvent {
  station: Station!
  plannedTime: String!
  actualTime: String
  delayMinutes: Int
  platform: String
}

type Leg {
  origin: StopEvent!
  destination: StopEvent!
  trainName: String
}

type Journey {
  id: ID!
  provider: String!
  departureTime: String!
  arrivalTime: String!
  transfers: Int!
  legs: [Leg!]!
}

type Query {
  searchTrains(from: String!, to: String!): [Journey!]!
}
    `,
    bridge: `version 1.5

tool sbbApi from std.httpCall {
  .baseUrl = "https://transport.opendata.ch/v1"
  .method = GET
  .path = "/connections"
  .cache = 60
  on error = { "connections": [] }
}

bridge Query.searchTrains {
  with sbbApi as api
  with input as i
  with output as o

  api.from <- i.from
  api.to <- i.to

  o <- api.connections[] as c {
    .id <- c.from.station.id
    .provider = "SBB"
    .departureTime <- c.from.departure
    .arrivalTime <- c.to.arrival
    .transfers <- c.transfers || 0

    .legs <- c.sections[] as s {
      .trainName <- s.journey.name || s.journey.category || "Walk"

      .origin.station.id <- s.departure.station.id
      .origin.station.name <- s.departure.station.name
      .origin.plannedTime <- s.departure.departure
      .origin.actualTime <- s.departure.departure
      .origin.delayMinutes <- s.departure.delay || 0
      .origin.platform <- s.departure.platform

      .destination.station.id <- s.arrival.station.id
      .destination.station.name <- s.arrival.station.name
      .destination.plannedTime <- s.arrival.arrival
      .destination.actualTime <- s.arrival.arrival
      .destination.delayMinutes <- s.arrival.delay || 0
      .destination.platform <- s.arrival.platform
    }
  }
}`,
    queries: [
      {
        name: "Bern \u2192 Z\u00fcrich",
        query: `{
  searchTrains(from: "Bern", to: "Z\u00fcrich") {
    id
    provider
    departureTime
    arrivalTime
    transfers
    legs {
      trainName
      origin {
        station { name }
        plannedTime
        platform
      }
      destination {
        station { name }
        plannedTime
        platform
      }
    }
  }
}`,
      },
      {
        name: "Z\u00fcrich \u2192 Gen\u00e8ve",
        query: `{
  searchTrains(from: "Z\u00fcrich", to: "Gen\u00e8ve") {
    id
    departureTime
    arrivalTime
    transfers
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.searchTrains",
        outputFields: "",
        input: { from: "Bern", to: "Zürich" },
      },
      {
        operation: "Query.searchTrains",
        outputFields: "departureTime,arrivalTime,transfers",
        input: { from: "Zürich", to: "Genève" },
      },
    ],
    context: `{}`,
  },
  {
    id: "passthrough",
    name: "Passthrough",
    description:
      "Pass input arguments directly to output fields with no transformation",
    schema: `
type Query {
  echo(text: String!, count: Int): EchoResult
}

type EchoResult {
  text: String
  count: Int
}
    `,
    bridge: `version 1.5

bridge Query.echo {
  with input as i
  with output as o

  o.text <- i.text
  o.count <- i.count
}`,
    queries: [
      {
        name: "Query 1",
        query: `{
  echo(text: "Hello Bridge!", count: 42) {
    text
    count
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.echo",
        outputFields: "",
        input: { text: "Hello Bridge!", count: 42 },
      },
    ],
    context: `{}`,
  },
  {
    id: "expressions",
    name: "Expressions",
    description:
      "Use inline math and comparison operators to transform values directly in wire assignments",
    schema: `
type Query {
  pricing(dollars: Float!, quantity: Int!, minOrder: Float): PricingResult
}

type PricingResult {
  cents: Float
  total: Float
  eligible: Boolean
}
    `,
    bridge: `version 1.5

bridge Query.pricing {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
  o.total <- i.dollars * i.quantity
  o.eligible <- i.dollars * i.quantity >= 50
}`,
    queries: [
      {
        name: "Query 1",
        query: `{
  pricing(dollars: 9.99, quantity: 3) {
    cents
    total
    eligible
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.pricing",
        outputFields: "",
        input: { dollars: 9.99, quantity: 3 },
      },
    ],
    context: `{}`,
  },
  {
    id: "ternary",
    name: "Conditional Wire (Ternary)",
    description:
      "Select between two sources based on a condition — only the chosen branch is evaluated",
    schema: `
type Query {
  pricing(
    isPro: Boolean!
    proPrice: Float!
    basicPrice: Float!
  ): PricingResult
}

type PricingResult {
  tier: String
  price: Float
  discount: Float
}
    `,
    bridge: `version 1.5

bridge Query.pricing {
  with input as i
  with output as o

  # String literal branches
  o.tier <- i.isPro ? "premium" : "basic"

  # Numeric literal branches
  o.discount <- i.isPro ? 20 : 5

  # Source ref branches — selects proPrice or basicPrice
  o.price <- i.isPro ? i.proPrice : i.basicPrice
}`,
    queries: [
      {
        name: "Query 1",
        query: `{
  pricing(isPro: true, proPrice: 49.99, basicPrice: 9.99) {
    tier
    price
    discount
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.pricing",
        outputFields: "",
        input: { isPro: true, proPrice: 49.99, basicPrice: 9.99 },
      },
    ],
    context: `{}`,
  },
  {
    id: "force",
    name: "Force (Side-Effects)",
    description:
      "Use 'force' to guarantee a tool executes as a side-effect even when no output fields come from it",
    schema: `type Query {
  _: String
}

type Mutation {
  submitFeedback(text: String!, rating: Int!): SubmitResult
}

type SubmitResult {
  accepted: Boolean
  message: String
}
    `,
    bridge: `version 1.5

# This tool POSTs feedback to a webhook.
# We don't read anything from its response —
# the call must still happen.
tool webhook from std.httpCall {
  .baseUrl = "https://httpbin.org"
  .path = "/post"
  .method = POST
}

bridge Mutation.submitFeedback {
  with webhook as wh
  with input as i
  with output as o

  # Wire the input into the request body
  wh.body.text <- i.text
  wh.body.rating <- i.rating

  # Force the webhook to execute even though no output
  # fields are read from it — this is the key difference
  # from a regular lazy wire.
  force wh

  # Output is derived from the input, not the HTTP response.
  # A 204 No Content or any non-JSON response would still
  # return these fields correctly.
  o.accepted = true
  o.message <- i.text
}`,
    queries: [
      {
        name: "Submit",
        query: `mutation {
  submitFeedback(text: "Great product!", rating: 5) {
    accepted
    message
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Mutation.submitFeedback",
        outputFields: "",
        input: { text: "Great product!", rating: 5 },
      },
    ],
    context: `{}`,
  },
  {
    id: "alias",
    name: "Alias (Rename & Cache)",
    description:
      "alias is a fully compatible wire — supports ?., ||, ??, catch, and full expression syntax (math, comparison, not, parentheses, ternary)",
    schema: `
type Query {
  profile(userId: String!): UserProfile
}

type UserProfile {
  displayName: String
  location: String
  website: String
  upperName: String
  isPremium: Boolean
}
    `,
    bridge: `version 1.5

tool userApi from std.httpCall {
  .baseUrl = "https://jsonplaceholder.typicode.com"
  .path = "/users/1"
  .cache = 60
}

bridge Query.profile {
  with userApi as api
  with std.str.toUpperCase as uc
  with input as i
  with output as o

  # 1. Simple rename — give a deeply nested path a short name
  alias api.address.city as city

  # 2. Falsy fallback — use "Anonymous" if username is empty or null
  alias api.username || "Anonymous" as displayName

  # 3. Nullish fallback — only override if value is strictly null/undefined
  alias api.website ?? "https://example.com" as site

  # 4. Mixed chain — ?? then || in any order
  alias api.nickname ?? api.username || "Guest" as greeting

  # 4. Error boundary — if the pipe tool throws, default to "UNKNOWN"
  alias uc:api.name catch "UNKNOWN" as upperName

  # 5. Math/comparison expression — alias fully evaluates the expression
  alias api.id <= 5 as isPremium

  o.displayName <- displayName
  o.location <- city || "Unknown city"
  o.website <- site
  o.upperName <- upperName
  o.isPremium <- isPremium
}`,
    queries: [
      {
        name: "Query 1",
        query: `{
  profile(userId: "1") {
    displayName
    location
    website
    upperName
    isPremium
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.profile",
        outputFields: "",
        input: { userId: "1" },
      },
    ],
    context: `{}`,
  },
  {
    id: "string-interpolation",
    name: "String Interpolation",
    description:
      "Build strings from multiple sources using {…} template placeholders in pull wires",
    schema: `
type Query {
  userProfile(firstName: String!, lastName: String!, id: ID!): UserProfile
}

type UserProfile {
  greeting: String
  fullName: String
  profileUrl: String
  badge: String
}
    `,
    bridge: `version 1.5

bridge Query.userProfile {
  with input as i
  with output as o

  o.greeting <- "Hello, {i.firstName}!"
  o.fullName <- "{i.firstName} {i.lastName}"
  o.profileUrl <- "/users/{i.id}/profile"
  o.badge <- "{i.firstName} (#{i.id})"
}`,
    queries: [
      {
        name: "Alice",
        query: `{
  userProfile(firstName: "Alice", lastName: "Smith", id: "42") {
    greeting
    fullName
    profileUrl
    badge
  }
}`,
      },
      {
        name: "Bob",
        query: `{
  userProfile(firstName: "Bob", lastName: "Johnson", id: "99") {
    greeting
    fullName
    profileUrl
    badge
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.userProfile",
        outputFields: "",
        input: { firstName: "Alice", lastName: "Smith", id: "42" },
      },
      {
        operation: "Query.userProfile",
        outputFields: "",
        input: { firstName: "Bob", lastName: "Johnson", id: "99" },
      },
    ],
    context: `{}`,
  },
  {
    id: "path-scoping",
    name: "Path Scoping (Nested Objects)",
    description:
      "Group deeply nested wires with path scoping blocks — syntactic sugar that avoids repeating long target prefixes",
    schema: `
type Query {
  createPayload(
    name: String!
    email: String!
    theme: String
    isPro: Boolean
  ): Payload
}

type Payload {
  method: String
  body: Body
}

type Body {
  profile: Profile
  settings: Settings
}

type Profile {
  name: String
  email: String
  displayName: String
}

type Settings {
  theme: String
  tier: String
  notifications: Boolean
}
    `,
    bridge: `version 1.5

bridge Query.createPayload {
  with input as i
  with output as o

  o.method = "POST"

  # Path scoping: group nested fields under a common prefix
  o.body {
    .profile {
      .name <- i.name
      .email <- i.email
      .displayName <- "{i.name} ({i.email})"
    }
    .settings {
      .theme <- i.theme || "light"
      .tier <- i.isPro ? "premium" : "basic"
      .notifications = true
    }
  }
}`,
    queries: [
      {
        name: "Pro user",
        query: `{
  createPayload(name: "Alice", email: "alice@example.com", theme: "dark", isPro: true) {
    method
    body {
      profile {
        name
        email
        displayName
      }
      settings {
        theme
        tier
        notifications
      }
    }
  }
}`,
      },
      {
        name: "Basic user",
        query: `{
  createPayload(name: "Bob", email: "bob@example.com", isPro: false) {
    method
    body {
      profile {
        name
        displayName
      }
      settings {
        theme
        tier
        notifications
      }
    }
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.createPayload",
        outputFields: "",
        input: {
          name: "Alice",
          email: "alice@example.com",
          theme: "dark",
          isPro: true,
        },
      },
      {
        operation: "Query.createPayload",
        outputFields: "",
        input: { name: "Bob", email: "bob@example.com", isPro: false },
      },
    ],
    context: `{}`,
  },
  {
    id: "boolean-logic",
    name: "Boolean Logic",
    description:
      "Use `and`, `or`, and `not` keywords for clear, unambiguous boolean expressions in inline policy evaluation",
    schema: `
type Query {
  evaluate(age: Int!, verified: Boolean!, role: String!): PolicyResult
}

type PolicyResult {
  approved: Boolean
  requireMFA: Boolean
}
    `,
    bridge: `version 1.5

bridge Query.evaluate {
  with input as i
  with output as o

  o.approved <- (i.age > 18 and i.verified) or i.role == "ADMIN"
  o.requireMFA <- not (i.verified)
}`,
    queries: [
      {
        name: "Approved User",
        query: `{
  evaluate(age: 25, verified: true, role: "USER") {
    approved
    requireMFA
  }
}`,
      },
      {
        name: "Admin Override",
        query: `{
  evaluate(age: 15, verified: false, role: "ADMIN") {
    approved
    requireMFA
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.evaluate",
        outputFields: "",
        input: { age: 25, verified: true, role: "USER" },
      },
      {
        operation: "Query.evaluate",
        outputFields: "",
        input: { age: 15, verified: false, role: "ADMIN" },
      },
    ],
    context: `{}`,
  },
  {
    id: "control-flow-throw-panic",
    name: "Control Flow (Throw/Panic)",
    description:
      "Use throw for recoverable validation failures and panic for unrecoverable fatal errors",
    schema: `
type Query {
  validateProfile(name: String, fatal: Boolean): ValidationResult
}

type ValidationResult {
  name: String
  status: String
}
    `,
    bridge: `version 1.5

bridge Query.validateProfile {
  with input as i
  with output as o

  o.name <- i.name || throw "name is required"
  o.status <- i.fatal ? null : "ok" ?? panic "fatal validation error"
}`,
    queries: [
      {
        name: "Valid input",
        query: `{
  validateProfile(name: "Ada", fatal: false) {
    name
    status
  }
}`,
      },
      {
        name: "Throw: missing name",
        query: `{
  validateProfile(fatal: false) {
    name
    status
  }
}`,
      },
      {
        name: "Panic: fatal flag",
        query: `{
  validateProfile(name: "Ada", fatal: true) {
    name
    status
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.validateProfile",
        outputFields: "",
        input: { name: "Ada", fatal: false },
      },
      {
        operation: "Query.validateProfile",
        outputFields: "",
        input: { fatal: false },
      },
      {
        operation: "Query.validateProfile",
        outputFields: "",
        input: { name: "Ada", fatal: true },
      },
    ],
    context: `{}`,
  },
  {
    id: "control-flow-break-continue",
    name: "Array Control Flow (Break/Continue)",
    description:
      "Use continue 2 / break 2 to skip or stop from a nested array by targeting the parent loop",
    schema: `
type Item {
  sku: String
  price: Float
}

type Category {
  name: String
  items: [Item!]!
}

type Query {
  processCatalog: [Category!]!
}
    `,
    bridge: `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog[] as cat {
    .name <- cat.name
    .items <- cat.items[] as item {
      .sku <- item.sku ?? continue 2
      .price <- item.price ?? break 2
    }
  }
}`,
    queries: [
      {
        name: "Process catalog with break/continue",
        query: `{
  processCatalog {
    name
    items {
      sku
      price
    }
  }
}`,
      },
    ],
    standaloneQueries: [
      {
        operation: "Query.processCatalog",
        outputFields: "",
        input: {},
      },
    ],
    context: `{
  "catalog": [
    {
      "name": "Summer",
      "items": [
        { "sku": "S-1", "price": 19.99 },
        { "sku": "S-2", "price": 29.99 }
      ]
    },
    {
      "name": "Skip category with continue 2",
      "items": [
        { "sku": null, "price": 999.99 },
        { "sku": "SHOULD-NOT-APPEAR", "price": 1.0 }
      ]
    },
    {
      "name": "Stop all with break 2",
      "items": [
        { "sku": "W-1", "price": null },
        { "sku": "W-3", "price": 49.99 }
      ]
    },
    {
      "name": "Never reached after break 2",
      "items": [
        { "sku": "N-1", "price": 10.0 }
      ]
    }
  ]
}`,
  },
];
