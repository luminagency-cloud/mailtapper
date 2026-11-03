import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { after, before, describe, it } from "node:test";
import "./block-network.js";

function loadTestEnv(): void {
  process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:5432/mailtapper_test";
  process.env.MAILTAPPER_KEK_B64 ??= Buffer.alloc(32, 2).toString("base64");
  process.env.MAILTAPPER_LOCATOR_SECRET ??= "test-locator-secret-value";
  process.env.PUBLIC_BASE_URL ??= "http://127.0.0.1:4321";
  process.env.LOG_LEVEL ??= "silent";
}

loadTestEnv();

const KEY = "Bearer mt_test_key";

const connections = [
  {
    id: "11111111-1111-4111-8111-111111111111", label: "Newport Hub", username: "david@newporthub.com",
    source_account: "david@newporthub.com", smtp_username: null, status: "active", send_enabled: true,
    from_name: "David Marlowe", last_error: null, smtp_last_error: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222", label: null, username: "test@example.com",
    source_account: "test@example.com", smtp_username: null, status: "active", send_enabled: false,
    from_name: null, last_error: null, smtp_last_error: null,
  },
];

/** A stand-in for the real /v1 routes, so the MCP layer runs end to end with no database or SMTP. */
async function buildStubApp(sent: unknown[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.authorization !== KEY) return reply.code(401).send({ error: "Unauthorized", code: "unauthorized" });
  });
  app.get("/v1/connections", async () => ({ data: connections }));
  app.post("/v1/connections/:id/send", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = connections.find((x) => x.id === id);
    if (!c?.send_enabled) return reply.code(403).send({ error: "Sending is not enabled for this mailbox.", code: "forbidden" });
    sent.push({ id, body: req.body });
    return { ok: true, connection_id: id, message_id: "<m1@newporthub.com>", accepted: ["a@example.com"], rejected: [], saved_to_sent: true };
  });
  const { registerMcp } = await import("../src/http/mcp.js");
  registerMcp(app);
  return app;
}

async function rpc(app: FastifyInstance, method: string, params: unknown = {}, id = 1) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: KEY, "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id, method, params },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

describe("MCP endpoint", () => {
  const sent: unknown[] = [];
  let app: FastifyInstance;

  before(async () => {
    app = await buildStubApp(sent);
  });

  after(async () => {
    await app.close();
  });

  it("initializes and lists the two tools", async () => {
    const init = await rpc(app, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.result.serverInfo.name, "mailtapper");

    const list = await rpc(app, "tools/list", {}, 2);
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name).sort(), ["list_mailboxes", "send_email"]);
  });

  it("lists mailboxes with their From address", async () => {
    const res = await rpc(app, "tools/call", { name: "list_mailboxes", arguments: {} }, 3);
    const { mailboxes } = JSON.parse(res.result.content[0].text);
    assert.equal(mailboxes[0].address, "david@newporthub.com");
    assert.equal(mailboxes[0].send_enabled, true);
  });

  it("sends from a mailbox picked by address and passes the message through", async () => {
    const res = await rpc(app, "tools/call", {
      name: "send_email",
      arguments: { mailbox: "David@NewportHub.com", to: ["a@example.com"], subject: "Hi", text: "Hello" },
    }, 4);
    assert.equal(res.result.isError, false, res.result.content[0].text);
    assert.equal(JSON.parse(res.result.content[0].text).from, "david@newporthub.com");
    assert.deepEqual(sent.at(-1), {
      id: connections[0]!.id,
      body: { to: ["a@example.com"], subject: "Hi", text: "Hello" },
    });
  });

  it("returns tool errors for unknown or send-disabled mailboxes without sending", async () => {
    const before = sent.length;
    const unknown = await rpc(app, "tools/call", {
      name: "send_email",
      arguments: { mailbox: "nobody@example.com", to: ["a@example.com"], subject: "Hi", text: "Hello" },
    }, 5);
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0].text, /No mailbox matches/);

    const disabled = await rpc(app, "tools/call", {
      name: "send_email",
      arguments: { mailbox: "test@example.com", to: ["a@example.com"], subject: "Hi", text: "Hello" },
    }, 6);
    assert.equal(disabled.result.isError, true);
    assert.match(disabled.result.content[0].text, /403/);
    assert.equal(sent.length, before);
  });

  it("rejects GET on /mcp", async () => {
    const res = await app.inject({ method: "GET", url: "/mcp", headers: { authorization: KEY } });
    assert.equal(res.statusCode, 405);
  });
});

describe("MCP endpoint on the real server", () => {
  it("requires an API key", async () => {
    const { buildServer } = await import("../src/http/server.js");
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});
