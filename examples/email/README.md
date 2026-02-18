# Email Gateway Example

Sends emails via SendGrid through a declarative bridge.

## Files

- `Email.graphql` — GraphQL schema
- `sendgrid.bridge` — provider definition + field wiring
- `server.ts` — spins up a yoga server from the two files

The bridge maps GraphQL input fields to SendGrid's parameter names (`body` → `content`) and extracts the message ID from the response's nested header path.

## Run

```bash
SENDGRID_API_KEY=sg_... npx tsx examples/email/server.ts
```

Then:

```bash
curl -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query": "mutation { sendEmail(to: \"alice@example.com\", from: \"bob@example.com\", subject: \"Hello\", body: \"Hi there\") { messageId } }"}'
```
