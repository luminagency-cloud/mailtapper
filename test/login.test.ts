import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { after, before, describe, it } from "node:test";
import "./block-network.js";

process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:5432/mailtapper_test";
process.env.MAILTAPPER_KEK_B64 ??= Buffer.alloc(32, 2).toString("base64");
process.env.MAILTAPPER_LOCATOR_SECRET ??= "test-locator-secret-value";
process.env.PUBLIC_BASE_URL ??= "http://127.0.0.1:4321";
process.env.LOG_LEVEL ??= "silent";
delete process.env.LOGIN_SENDER_CONNECTION_ID;

describe("email sign-in", () => {
  let app: FastifyInstance;
  const cookie = "theme=dark; mt_session=" + "a".repeat(43);

  before(async () => {
    const { buildServer } = await import("../src/http/server.js");
    app = await buildServer();
  });
  after(async () => {
    await app.close();
  });

  it("reads only a well-formed session cookie and sets it HttpOnly, Secure, SameSite=Strict", async () => {
    const { readSessionCookie } = await import("../src/http/auth.js");
    const { sessionCookie } = await import("../src/http/login.js");
    assert.equal(readSessionCookie(cookie), "a".repeat(43));
    assert.equal(readSessionCookie("mt_session=short"), null);
    assert.equal(readSessionCookie("xmt_session=" + "a".repeat(43)), null);
    assert.equal(readSessionCookie(undefined), null);
    const set = sessionCookie("tok", 30_000);
    for (const part of ["mt_session=tok", "HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=30"]) assert.match(set, new RegExp(part));
  });

  it("refuses cookie-authenticated writes without the x-mailtapper header (CSRF)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /x-mailtapper/);
  });

  it("validates the email, then reports when no sender mailbox is set", async () => {
    const bad = await app.inject({ method: "POST", url: "/auth/login", headers: { "content-type": "application/json" }, payload: { email: "nope" } });
    assert.equal(bad.statusCode, 400);
    const off = await app.inject({ method: "POST", url: "/auth/login", headers: { "content-type": "application/json" }, payload: { email: "A@Example.com" } });
    assert.equal(off.statusCode, 503);
    assert.equal(off.json().code, "login_unavailable");
  });

  it("serves a dashboard whose script parses", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    const js = res.body.split("<script>")[1]!.split("</script>")[0]!;
    assert.doesNotThrow(() => new Function(js));
    assert.match(res.body, /\/auth\/login/);
  });
});
