import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { after, before, describe, it } from "node:test";
import "./block-network.js";
import { HttpError } from "../src/util.js";

function loadTestEnv(): void {
  process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:5432/mailtapper_test";
  process.env.MAILTAPPER_KEK_B64 ??= Buffer.alloc(32, 2).toString("base64");
  process.env.MAILTAPPER_LOCATOR_SECRET ??= "test-locator-secret-value";
  process.env.PUBLIC_BASE_URL ??= "http://127.0.0.1:4321";
  process.env.LOG_LEVEL ??= "silent";
}

loadTestEnv();

describe("send and mark-read auth", () => {
  let app: FastifyInstance;

  before(async () => {
    loadTestEnv();
    const { buildServer } = await import("../src/http/server.js");
    app = await buildServer();
  });

  after(async () => {
    await app.close();
  });

  it("registers the write routes and rejects unauthenticated calls", async () => {
    const routes = app.printRoutes();
    assert.match(routes, /send \(POST\)/);
    assert.match(routes, /read \(POST\)/);

    const send = await app.inject({
      method: "POST",
      url: "/v1/connections/00000000-0000-0000-0000-000000000000/send",
      headers: { "content-type": "application/json" },
      payload: { to: "a@example.com", subject: "hi", text: "hello" },
    });
    assert.equal(send.statusCode, 401);
    assert.equal(send.json().code, "unauthorized");

    const basic = await app.inject({
      method: "POST",
      url: "/v1/messages/read",
      headers: { authorization: "Basic bm90OmE=", "content-type": "application/json" },
      payload: { ids: ["abc"] },
    });
    assert.equal(basic.statusCode, 401);

    const mark = await app.inject({
      method: "POST",
      url: "/v1/messages/read",
      headers: { "content-type": "application/json" },
      payload: { ids: ["abc"], read: true },
    });
    assert.equal(mark.statusCode, 401);
    assert.equal(mark.json().code, "unauthorized");

    const messages = await app.inject({ method: "GET", url: "/v1/messages" });
    assert.equal(messages.statusCode, 401);

    const { encodeLocator } = await import("../src/imap/locator.js");
    const { MAX_PARAM_LENGTH } = await import("../src/http/server.js");
    const id = encodeLocator({ connectionId: "550e8400-e29b-41d4-a716-446655440000", folder: "INBOX", uid: 42, uidValidity: 7 });
    assert.ok(id.length > 100);
    assert.equal(id.includes("."), true);
    const one = app.findRoute({ method: "GET", url: `/v1/messages/${id}` });
    assert.equal(one?.params.id, id);
    const file = app.findRoute({ method: "GET", url: `/v1/messages/${id}/attachments/0` });
    assert.equal(file?.params.id, id);
    assert.equal(file?.params.index, "0");
    const longId = "a".repeat(MAX_PARAM_LENGTH);
    assert.equal(app.findRoute({ method: "GET", url: `/v1/messages/${longId}` })?.params.id, longId);
    assert.equal(app.findRoute({ method: "GET", url: `/v1/messages/${"b".repeat(MAX_PARAM_LENGTH + 1)}` }), null);
    assert.match(app.printRoutes(), /attachments/);

    const attachment = await app.inject({ method: "GET", url: `/v1/messages/${id}/attachments/0` });
    assert.equal(attachment.statusCode, 401);
    assert.equal(attachment.json().code, "unauthorized");

    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    const expectedVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
    assert.equal(health.json().version, expectedVersion);
  });

  it("does not let a read-only key satisfy send or mark-read scopes", async () => {
    const { requireScope } = await import("../src/http/auth.js");
    const readOnly = { auth: { scopes: ["messages:read"] } } as Parameters<typeof requireScope>[0];
    const sender = { auth: { scopes: ["messages:send"] } } as Parameters<typeof requireScope>[0];
    const writer = { auth: { scopes: ["messages:write"] } } as Parameters<typeof requireScope>[0];
    const admin = { auth: { scopes: ["admin"] } } as Parameters<typeof requireScope>[0];

    assert.throws(() => requireScope(readOnly, "messages:send"), (err: unknown) => err instanceof HttpError && err.status === 403);
    assert.throws(() => requireScope(readOnly, "messages:write"), (err: unknown) => err instanceof HttpError && err.status === 403);
    assert.throws(() => requireScope(sender, "messages:write"), (err: unknown) => err instanceof HttpError && err.status === 403);
    assert.doesNotThrow(() => requireScope(sender, "messages:send"));
    assert.doesNotThrow(() => requireScope(writer, "messages:write"));
    assert.doesNotThrow(() => requireScope(admin, "messages:send"));
    assert.doesNotThrow(() => requireScope(admin, "messages:write"));
  });

  it("rejects a tampered message id and keeps a valid one in the batch", async () => {
    const { markMessages } = await import("../src/imap/flags.js");
    const { decodeLocator, encodeLocator } = await import("../src/imap/locator.js");
    const id = encodeLocator({ connectionId: "c1", folder: "INBOX", uid: 5, uidValidity: 9 });
    const tampered = id.slice(0, -1) + (id.endsWith("a") ? "b" : "a");
    const result = await markMessages({
      ids: [tampered, id],
      read: true,
      decode: decodeLocator,
      load: async () => ({ status: "active" }),
      apply: async (_connection, _connectionId, items) => ({ updated: items.map((item) => item.id), failed: [] }),
    });
    assert.deepEqual(result.updated, [id]);
    assert.equal(result.failed[0]?.id, tampered);
    assert.equal(result.failed[0]?.code, "gone");
  });
});
