# Hand-coded Node.js — baseline HTTP server doing manual fetch + mapping.

FROM node:24-slim

WORKDIR /app
COPY . .

EXPOSE 3000
CMD ["node", "--experimental-transform-types", "handcoded.ts"]
