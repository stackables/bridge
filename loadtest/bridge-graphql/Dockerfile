# Bridge GraphQL — graphql-yoga server with bridgeTransform.

FROM node:24-slim

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "--experimental-transform-types", "bridge-graphql.ts"]
