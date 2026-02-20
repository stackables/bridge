import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

const typeDefs = /* GraphQL */ `
  type Query {
    _: Boolean
  }
  type Mutation {
    sendEmail(
      to: String!
      from: String!
      subject: String!
      body: String!
    ): EmailResult
  }
  type EmailResult {
    messageId: String
  }
`;

const bridgeText = `
bridge Mutation.sendEmail {
  with sendgrid.send as sg
  with input as i
  with output as o

sg.to <- i.to
sg.from <- i.from
sg.subject <- i.subject
sg.content <- i.body
o.messageId <- sg.headers.x-message-id

}`;

const fakeEmailTool = async (_params: Record<string, any>) => ({
  statusCode: 202,
  headers: {
    "x-message-id": "msg_abc123",
  },
  body: { message: "Queued" },
});

function makeExecutor() {
  const instructions = parseBridge(bridgeText);
  const gateway = createGateway(typeDefs, instructions, {
    tools: { "sendgrid.send": fakeEmailTool },
  });
  return buildHTTPExecutor({ fetch: gateway.fetch as any });
}

describe("email mutation", () => {
  test("sends email and extracts message id from response header path", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`
                mutation {
                    sendEmail(
                        to: "alice@example.com"
                        from: "bob@example.com"
                        subject: "Hello"
                        body: "Hi there"
                    ) {
                        messageId
                    }
                }
            `),
    });
    assert.equal(result.data.sendEmail.messageId, "msg_abc123");
  });

  test("tool receives renamed fields", async () => {
    let capturedParams: Record<string, any> = {};
    const capture = async (params: Record<string, any>) => {
      capturedParams = params;
      return { headers: { "x-message-id": "test" } };
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { "sendgrid.send": capture },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    await executor({
      document: parse(`
                mutation {
                    sendEmail(
                        to: "alice@example.com"
                        from: "bob@example.com"
                        subject: "Hello"
                        body: "Hi there"
                    ) {
                        messageId
                    }
                }
            `),
    });

    assert.equal(capturedParams.to, "alice@example.com");
    assert.equal(capturedParams.from, "bob@example.com");
    assert.equal(capturedParams.subject, "Hello");
    assert.equal(capturedParams.content, "Hi there"); // body -> content rename
  });
});
