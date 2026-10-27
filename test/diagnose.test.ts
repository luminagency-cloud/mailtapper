import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./block-network.js";
import { diagnoseMailError } from "../src/imap/validator.js";

const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

describe("diagnoseMailError", () => {
  it("names the SMTP side and the TLS mode field for ssl on port 587", () => {
    const d = diagnoseMailError(err("ssl3_get_record:wrong version number"), "send", { port: 587, tlsMode: "ssl" });
    assert.equal(d.side, "send");
    assert.equal(d.field, "smtp_tls_mode");
    assert.match(d.message, /^Send \(SMTP\): /);
    assert.match(d.hint ?? "", /587 expects STARTTLS, not SSL\/TLS/);
  });

  it("blames the TLS mode when STARTTLS waits on an implicit-TLS port", () => {
    const d = diagnoseMailError(err("Failed to receive greeting from server in required time", { code: "GREETING_TIMEOUT" }), "receive", {
      port: 993,
      tlsMode: "starttls",
    });
    assert.equal(d.field, "tls_mode");
    assert.match(d.message, /^Receive \(IMAP\): /);
    assert.match(d.hint ?? "", /993 expects SSL\/TLS/);
  });

  it("maps login, host, port and certificate failures to their fields without echoing server text", () => {
    const auth = diagnoseMailError(err("Command failed", { authenticationFailed: true }), "receive", { port: 993, tlsMode: "ssl" });
    assert.equal(auth.field, "password");
    const smtpAuth = diagnoseMailError(err("Invalid login: 535 nope for secret-password", { code: "EAUTH" }), "send", { port: 587, tlsMode: "starttls" });
    assert.equal(smtpAuth.field, "smtp_password");
    assert.equal(smtpAuth.message.includes("secret-password"), false);
    assert.equal(diagnoseMailError(err("getaddrinfo ENOTFOUND mail.nope"), "send", { port: 587, tlsMode: "starttls" }).field, "smtp_host");
    assert.equal(diagnoseMailError(err("connect ECONNREFUSED 1.2.3.4:144"), "receive", { port: 144, tlsMode: "ssl" }).field, "port");
    assert.equal(diagnoseMailError(err("self-signed certificate"), "send", { port: 465, tlsMode: "ssl" }).field, "allow_invalid_cert");
    // Node's exact text for an expired cert (seen against expired.badssl.com).
    assert.equal(diagnoseMailError(err("certificate has expired"), "receive", { port: 993, tlsMode: "ssl" }).field, "allow_invalid_cert");
    assert.equal(diagnoseMailError(err("Hostname/IP does not match certificate's altnames"), "receive", { port: 993, tlsMode: "ssl" }).field, "host");
  });
});
