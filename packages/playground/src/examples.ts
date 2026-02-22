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
