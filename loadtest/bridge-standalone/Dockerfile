# Bridge Standalone — Node.js executeBridge server (no GraphQL).

FROM node:24-slim

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "--experimental-transform-types", "bridge-standalone.ts"]
