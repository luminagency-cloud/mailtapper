import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import "./block-network.js";

// fetch.ts loads env.ts, so set the test env before importing it.
process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:5432/mailtapper_test";
process.env.MAILTAPPER_KEK_B64 ??= Buffer.alloc(32, 2).toString("base64");
process.env.MAILTAPPER_LOCATOR_SECRET ??= "test-locator-secret-value";
process.env.PUBLIC_BASE_URL ??= "http://127.0.0.1:4321";
const { buildSearchCriteria } = await import("../src/imap/fetch.js");

// imapflow's own compiler, so the test checks the IMAP SEARCH terms that go on the wire.
const { searchCompiler } = createRequire(import.meta.url)("imapflow/lib/search-compiler.js") as {
  searchCompiler: (connection: unknown, query: unknown) => { type: string; value: unknown }[];
};
const connection = { capabilities: new Map(), enabled: new Set(), mailbox: { flags: new Set() } };
const terms = (query: unknown) => JSON.stringify(searchCompiler(connection, query));

describe("buildSearchCriteria", () => {
  it("sends q as IMAP TEXT, ANDed with the other filters", () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const criteria = buildSearchCriteria({ since, from: "acme.com", unread: true, text: "invoice 1042", limit: 25 });
    assert.deepEqual(criteria, { since, seen: false, from: "acme.com", text: "invoice 1042" });
    const wire = terms(criteria);
    assert.match(wire, /"TEXT"/);
    assert.match(wire, /invoice 1042/);
    assert.match(wire, /"UNSEEN"/);
  });

  it("adds no TEXT term without q", () => {
    assert.doesNotMatch(terms(buildSearchCriteria({ since: new Date(), limit: 25 })), /"TEXT"/);
  });
});
