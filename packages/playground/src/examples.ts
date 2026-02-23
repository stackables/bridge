export type Example = {
  name: string;
  description: string;
  schema: string;
  bridge: string;
  queries: { name: string; query: string }[];
  context: string;
};

export const examples: Example[] = [
  {
    name: "String Transform",
    description:
      "Use std.upperCase and std.lowerCase to transform string fields using pipe syntax",
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
    bridge: `version 1.4

bridge Query.greet {
  with std.upperCase as uc
  with std.lowerCase as lc
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
    context: `{}`,
  },
  {
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
    bridge: `version 1.4

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
    bridge: `version 1.4

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
    context: `{
  "user": {
    "id": "usr_42",
    "role": "admin"
  }
}`,
  },
  {
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
    bridge: `version 1.4

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
    context: `{}`,
  },
  {
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
    bridge: `version 1.4

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
    context: `{}`,
  },
  {
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
    bridge: `version 1.4

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
    context: `{}`,
  },
  {
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
    bridge: `version 1.4

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
    context: `{}`,
  },
  {
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
    bridge: `version 1.4

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
    context: `{}`,
  },
  {
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
    bridge: `version 1.4

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
    context: `{}`,
  },
  {
    name: "Alias (Rename & Cache)",
    description:
      "Use 'alias' to rename deep paths or cache pipe results — works at bridge body level and inside array mapping blocks",
    schema: `
type Query {
  searchTrains(from: String!, to: String!): [Journey!]!
}

type Journey {
  departureTime: String!
  arrivalTime: String!
  originStation: String!
  destinationStation: String!
  legs: [Leg!]!
}

type Leg {
  trainName: String
  fromStation: String
  fromTime: String
  toStation: String
  toTime: String
}
    `,
    bridge: `version 1.4

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
    # alias renames deeply nested paths for readability
    alias c.from as dep
    alias c.to as arr

    .departureTime <- dep.departure
    .arrivalTime <- arr.arrival
    .originStation <- dep.station.name
    .destinationStation <- arr.station.name

    .legs <- c.sections[] as s {
      .trainName <- s.journey.name || s.journey.category || "Walk"
      .fromStation <- s.departure.station.name
      .fromTime <- s.departure.departure
      .toStation <- s.arrival.station.name
      .toTime <- s.arrival.arrival
    }
  }
}`,
    queries: [
      {
        name: "Bern \u2192 Z\u00fcrich",
        query: `{
  searchTrains(from: "Bern", to: "Zürich") {
    departureTime
    arrivalTime
    originStation
    destinationStation
    legs {
      trainName
      fromStation
      fromTime
      toStation
      toTime
    }
  }
}`,
      },
    ],
    context: `{}`,
  },
  {
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
    bridge: `version 1.4

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
    context: `{}`,
  },
];
