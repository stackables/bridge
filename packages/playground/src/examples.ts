export type Example = {
  name: string;
  description: string;
  schema: string;
  bridge: string;
  query: string;
  context: string;
};

export const examples: Example[] = [
  {
    name: "String Transform",
    description: "Use std.upperCase and std.lowerCase to transform string fields using pipe syntax",
    schema: /* GraphQL */ `type Query {
  greet(name: String!): Greeting
}

type Greeting {
  message: String
  upper: String
  lower: String
}`,
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
    query: `{
  greet(name: "Hello Bridge") {
    message
    upper
    lower
  }
}`,
    context: `{}`,
  },
  {
    name: "Constants",
    description: "Hardcode constant values directly in bridge files using the = assignment syntax",
    schema: /* GraphQL */ `type Query {
  config: Config
}

type Config {
  version: String
  env: String
  label: String
}`,
    bridge: `version 1.4

bridge Query.config {
  with output as o

  o.version = "1.0.0"
  o.env = "browser"
  o.label = "Bridge Playground"
}`,
    query: `{
  config {
    version
    env
    label
  }
}`,
    context: `{}`,
  },
  {
    name: "Context",
    description: "Access the GraphQL context inside bridge files using 'with context'",
    schema: /* GraphQL */ `type Query {
  profile: Profile
}

type Profile {
  userId: String
  role: String
}`,
    bridge: `version 1.4

bridge Query.profile {
  with context as ctx
  with output as o

  o.userId <- ctx.user.id
  o.role <- ctx.user.role
}`,
    query: `{
  profile {
    userId
    role
  }
}`,
    context: `{
  "user": {
    "id": "usr_42",
    "role": "admin"
  }
}`,
  },
  {
    name: "HTTP Tool",
    description: "Declare a reusable HTTP tool and wire its response to GraphQL output fields",
    schema: /* GraphQL */ `type Query {
  location(city: String!): Location
}

type Location {
  lat: Float
  lon: Float
}`,
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
    query: `{
  location(city: "Berlin") {
    lat
    lon
  }
}`,
    context: `{}`,
  },
  {
    name: "SBB Train Search",
    description: "Query the Swiss public transport API to find train connections between two stations",
    schema: /* GraphQL */ `type Station {
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
}`,
    bridge: `version 1.4

tool sbbApi from std.httpCall {
  .baseUrl = "https://transport.opendata.ch/v1"
  .method = GET
  .path = "/connections"
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
    query: `{
  searchTrains(from: "Bern", to: "Zürich") {
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
    context: `{}`,
  },
  {
    name: "Passthrough",
    description: "Pass input arguments directly to output fields with no transformation",
    schema: /* GraphQL */ `type Query {
  echo(text: String!, count: Int): EchoResult
}

type EchoResult {
  text: String
  count: Int
}`,
    bridge: `version 1.4

bridge Query.echo {
  with input as i
  with output as o

  o.text <- i.text
  o.count <- i.count
}`,
    query: `{
  echo(text: "Hello Bridge!", count: 42) {
    text
    count
  }
}`,
    context: `{}`,
  },
];
