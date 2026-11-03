/**
 * The only human surface in v1: a mobile-first admin + mailbox manager served at GET / .
 * Self-contained (no build step, no framework). The page holds no secrets.
 * Sign-in is by email link (see login.ts): the session lives in an HttpOnly cookie and
 * cookie-authenticated writes carry the x-mailtapper header. An API key can still be used
 * instead (kept in localStorage, sent as a Bearer token).
 *
 * The inner JS uses string concatenation (no backticks or template interpolation) so it embeds cleanly.
 * The only server-side interpolation is the SMTP defaults, shown as placeholders.
 */
import { env } from "../env.js";

export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#000000" />
<meta name="color-scheme" content="only light" />
<meta name="darkreader-lock" />
<title>MailTapper</title>
<style>
  /* "only light" stops browser auto-dark modes from inverting the black/yellow palette. */
  :root { --ink:#000; --bg:#fff; --hi:#ffd400; --r:12px; color-scheme:only light; }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .hidden { display:none !important; }

  .top { position:sticky; top:0; z-index:5; display:flex; align-items:center; justify-content:space-between; gap:12px;
    background:#000; color:var(--hi); padding:calc(10px + env(safe-area-inset-top)) 16px 10px; }
  .brand { font-weight:900; font-size:20px; letter-spacing:.2px; }
  .who { color:#fff; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:60%; }

  .wrap { max-width:1040px; margin:0 auto; padding:16px 16px calc(96px + env(safe-area-inset-bottom)); }
  h1 { font-size:28px; line-height:1.2; margin:24px 0 8px; }
  h2 { font-size:22px; line-height:1.2; margin:0; }
  p { margin:8px 0; }
  .small { font-size:14px; }

  input, select { width:100%; font:inherit; font-size:17px; color:#000; background:#fff; min-height:48px;
    padding:10px 12px; border:2px solid #000; border-radius:10px; }
  input[type=checkbox] { width:24px; height:24px; min-height:0; margin:0; flex:none; accent-color:#000; }
  input:focus, select:focus, button:focus-visible, summary:focus-visible { outline:4px solid var(--hi); outline-offset:2px; }
  label { display:flex; flex-direction:column; gap:6px; font-weight:700; font-size:15px; }
  label.check { flex-direction:row; align-items:center; gap:12px; font-weight:600; font-size:16px; min-height:44px; }
  label.field-err { background:var(--hi); outline:4px solid #000; outline-offset:4px; border-radius:6px; }

  button { font:inherit; font-weight:800; cursor:pointer; min-height:48px; padding:10px 18px; border-radius:10px;
    border:2px solid #000; background:#000; color:var(--hi); }
  button.ghost { background:#fff; color:#000; }
  button.danger { background:#fff; color:#000; border-style:dashed; }
  button.block { width:100%; }
  button:disabled { opacity:.5; cursor:default; }

  .form { display:grid; gap:16px; }
  .form details { border:2px solid #000; border-radius:var(--r); padding:0 14px; }
  .form details[open] { padding-bottom:14px; }
  .form details > summary { cursor:pointer; font-weight:800; min-height:48px; display:flex; align-items:center; }
  .form details > label + label { margin-top:14px; }
  .form-actions { display:flex; gap:10px; }
  .form-actions button { flex:1; }

  .head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:8px 0 16px; }
  .cards { display:grid; gap:14px; }
  .card { border:2px solid #000; border-radius:var(--r); padding:14px; background:#fff; min-width:0; }
  .card-top { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
  .title { font-weight:800; font-size:18px; overflow-wrap:anywhere; }
  .sub { font-size:14px; }
  .facts { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:12px 0 0; font-size:15px; }
  .facts dt { font-weight:700; }
  .facts dd { margin:0; overflow-wrap:anywhere; }
  .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:14px; }
  .badge { flex:none; display:inline-block; padding:3px 10px; border-radius:999px; font-size:14px; font-weight:800;
    background:#000; color:var(--hi); }
  .badge.off { background:#fff; color:#000; border:2px solid #000; }
  .err { display:block; background:#000; color:var(--hi); padding:6px 10px; border-radius:8px; margin-top:10px;
    font-size:14px; overflow-wrap:anywhere; }
  .empty { border:2px dashed #000; border-radius:var(--r); padding:20px; text-align:center; }

  .result { margin-top:12px; border-top:2px solid #000; padding-top:10px; }
  .result-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-weight:800; }
  .result-head button { min-height:36px; padding:4px 12px; font-size:15px; }
  .result pre { margin:8px 0 0; padding:10px; background:#000; color:var(--hi); border-radius:8px; white-space:pre-wrap;
    word-break:break-word; max-height:50vh; overflow:auto; font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }

  .msg { min-height:24px; margin:12px 0 0; font-weight:600; }
  .msg.err { display:block; }

  .tabbar { position:fixed; left:0; right:0; bottom:0; z-index:5; display:flex; background:#000;
    padding:6px 6px calc(6px + env(safe-area-inset-bottom)); gap:6px; }
  .tabbar button { flex:1; min-height:52px; border-color:#000; background:#000; color:#fff; font-size:15px; }
  .tabbar button.active { background:var(--hi); color:#000; }

  .sheet-bg { position:fixed; inset:0; z-index:10; background:rgba(0,0,0,.6); display:flex; align-items:flex-end; justify-content:center; }
  .sheet { width:100%; max-width:560px; background:#fff; border-radius:16px 16px 0 0; padding:20px 16px calc(20px + env(safe-area-inset-bottom)); }
  .sheet code { display:block; margin:12px 0; padding:12px; background:#000; color:var(--hi); border-radius:8px;
    font:15px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow-wrap:anywhere; user-select:all; }
  .sheet .form-actions { margin-top:12px; }

  .toast { position:fixed; left:16px; right:16px; bottom:calc(76px + env(safe-area-inset-bottom)); z-index:20; margin:0 auto; max-width:560px;
    background:var(--hi); color:#000; border:2px solid #000; border-radius:10px; padding:12px 14px; font-weight:700; }

  .narrow { max-width:480px; margin:0 auto; }

  @media (min-width: 760px) {
    .cards { grid-template-columns:1fr 1fr; }
    .actions { grid-template-columns:repeat(4, 1fr); }
    .tabbar { position:sticky; top:52px; bottom:auto; max-width:1040px; margin:0 auto; background:#fff; padding:12px 16px 0; }
    .tabbar button { flex:none; background:#fff; color:#000; border-color:#000; }
    .tabbar button.active { background:#000; color:var(--hi); }
    .wrap { padding-bottom:64px; }
    .toast { bottom:24px; }
    .sheet-bg { align-items:center; }
    .sheet { border-radius:16px; }
    #mailboxFormWrap, #clientFormWrap { max-width:640px; }
  }
</style>
</head>
<body>
<header class="top"><div class="brand">MailTapper</div><div id="who" class="who"></div></header>
<nav id="tabbar" class="tabbar hidden" aria-label="Sections">
  <button data-tab="mailboxes" type="button">Mailboxes</button>
  <button data-tab="clients" type="button">Accounts</button>
  <button data-tab="me" type="button">Me</button>
</nav>

<main class="wrap">
  <section id="signinScreen" class="narrow hidden">
    <h1>Sign in</h1>
    <p>Type your email. We send you a link. Tap the link to sign in. No password.</p>
    <form id="loginForm" class="form" autocomplete="on">
      <label>Email <input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required placeholder="you@yourdomain.com" /></label>
      <button type="submit" class="block">Email me a sign-in link</button>
    </form>
    <p id="loginMsg" class="msg" aria-live="polite"></p>
    <form id="keyForm" class="form" autocomplete="off" style="margin-top:28px">
      <details>
        <summary>Use an API key instead</summary>
        <label>API key <input name="key" type="password" autocomplete="off" placeholder="mtapper_live_..." /></label>
        <div class="form-actions" style="margin-top:14px"><button type="submit">Use this key</button></div>
      </details>
    </form>
  </section>

  <section id="confirmScreen" class="narrow hidden">
    <h1>Finish signing in</h1>
    <p>Tap the button to sign in on this device.</p>
    <button id="confirmBtn" type="button" class="block">Sign in</button>
    <p id="confirmMsg" class="msg" aria-live="polite"></p>
  </section>

  <section id="mailboxesView" class="view hidden">
    <div id="mailboxListWrap">
      <div class="head"><h2>Mailboxes</h2><button id="addMailboxBtn" type="button">+ Add</button></div>
      <div id="connList" class="cards"></div>
    </div>

    <div id="mailboxFormWrap" class="hidden">
      <div class="head"><h2 id="mailboxFormTitle">Add mailbox</h2></div>
      <form id="addForm" class="form" autocomplete="off">
        <label>Email / username <input name="username" type="email" inputmode="email" autocapitalize="off" spellcheck="false" required placeholder="you@yourdomain.com" /></label>
        <label>Password <input name="password" type="password" required /></label>
        <label>IMAP host <input name="host" autocapitalize="off" spellcheck="false" required placeholder="mail.yourhost.com" /></label>
        <label>Port <input name="port" type="number" inputmode="numeric" value="993" required /></label>
        <label>TLS mode
          <select name="tls_mode">
            <option value="ssl">ssl (port 993)</option>
            <option value="starttls">starttls (port 143)</option>
            <option value="none">none</option>
          </select>
        </label>
        <label class="check"><input name="allow_invalid_cert" type="checkbox" /> Allow a self-signed certificate</label>
        <label class="check"><input name="send_enabled" type="checkbox" /> Enable sending (the SMTP login is checked before saving)</label>
        <details id="smtpDetails">
          <summary>Sending (SMTP) settings</summary>
          <label>From name <input name="from_name" placeholder="Newport Chess Club" /></label>
          <label>SMTP host <input name="smtp_host" autocapitalize="off" spellcheck="false" placeholder="${env.SMTP_DEFAULT_HOST} (default)" /></label>
          <label>SMTP port <input name="smtp_port" type="number" inputmode="numeric" placeholder="${env.SMTP_DEFAULT_PORT} (default)" /></label>
          <label>SMTP TLS mode
            <select name="smtp_tls_mode">
              <option value="">default (${env.SMTP_DEFAULT_TLS_MODE})</option>
              <option value="ssl">ssl (port 465)</option>
              <option value="starttls">starttls (port 587)</option>
              <option value="none">none</option>
            </select>
          </label>
          <label>SMTP username <input name="smtp_username" autocapitalize="off" spellcheck="false" placeholder="same as IMAP" /></label>
          <label>SMTP password <input name="smtp_password" type="password" placeholder="same as IMAP" /></label>
        </details>
        <details id="metaDetails">
          <summary>Label and host name</summary>
          <label>Label <input name="label" placeholder="Work, Support, Billing" /></label>
          <label>Host name tag <input name="provider" placeholder="imap_generic" /></label>
        </details>
        <div class="form-actions">
          <button id="cancelMailbox" class="ghost" type="button">Cancel</button>
          <button id="saveMailbox" type="submit">Check &amp; add</button>
        </div>
        <p id="addMsg" class="msg" aria-live="polite"></p>
      </form>
    </div>
  </section>

  <section id="clientsView" class="view hidden">
    <div id="clientListWrap">
      <div class="head"><h2>Accounts</h2><button id="addClientBtn" type="button">+ New</button></div>
      <div id="clientList" class="cards"></div>
    </div>
    <div id="clientFormWrap" class="hidden">
      <div class="head"><h2>New account</h2></div>
      <form id="createClientForm" class="form" autocomplete="off">
        <label>Account name <input name="client_name" required placeholder="Acme project" /></label>
        <label>Sign-in email (optional) <input name="client_email" type="email" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="owner@acme.com" /></label>
        <label>Tier
          <select name="tier">
            <option value="free">free</option>
            <option value="pro" selected>pro</option>
            <option value="scale">scale</option>
          </select>
        </label>
        <div class="form-actions">
          <button id="cancelClient" class="ghost" type="button">Cancel</button>
          <button type="submit">Create</button>
        </div>
        <p id="clientMsg" class="msg" aria-live="polite"></p>
      </form>
    </div>
  </section>

  <section id="meView" class="view hidden">
    <div class="head"><h2>Me</h2></div>
    <div class="card">
      <div class="title" id="meName"></div>
      <dl class="facts" id="meFacts"></dl>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="title">API key</div>
      <p class="small">Programs (luminmail, agents) use an API key. If a key is lost or leaked, make a new one.
        All current keys of this account stop working. Mailboxes and settings do not change.</p>
      <button id="rotateMine" type="button" class="block">Make a new API key</button>
    </div>
    <div style="margin-top:14px"><button id="signOut" type="button" class="ghost block">Sign out</button></div>
  </section>
</main>

<div id="sheetBg" class="sheet-bg hidden" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
  <div class="sheet">
    <h2 id="sheetTitle">New API key</h2>
    <p class="small" id="sheetText">Copy it now. It is shown only once.</p>
    <code id="sheetKey"></code>
    <div class="form-actions">
      <button id="copyKey" type="button">Copy</button>
      <button id="closeSheet" type="button" class="ghost">Done</button>
    </div>
  </div>
</div>
<div id="toast" class="toast hidden" role="status"></div>

<script>
  var $ = function (s) { return document.querySelector(s); };
  var mailboxResults = {};
  var mailboxById = {};
  var clientById = {};
  var editingMailboxId = null;
  var session = null;
  var toastTimer = null;

  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  function getKey() { return lsGet("mtap_key"); }

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }
  function fmtDate(value) {
    if (!value) return "never";
    var d = new Date(value);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function badge(text, on) { return "<span class='badge" + (on ? "" : " off") + "'>" + esc(text) + "</span>"; }
  function toast(text) {
    var t = $("#toast");
    t.textContent = text;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 5000);
  }
  function setMsg(el, text, isErr) { el.textContent = text || ""; el.className = "msg" + (isErr ? " err" : ""); }

  async function apiResult(path, opts) {
    opts = opts || {};
    var headers = { "content-type": "application/json", "x-mailtapper": "1" };
    var key = getKey();
    if (key) headers.authorization = "Bearer " + key;
    var res = await fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body, credentials: "same-origin" });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { error: text }; }
    return { status: res.status, http_ok: res.ok, data: data };
  }

  async function api(path, opts) {
    var result = await apiResult(path, opts);
    if (result.status === 401 && path.indexOf("/auth/") !== 0) { showScreen("signin"); }
    if (!result.http_ok) {
      var err = new Error((result.data && result.data.error) || ("HTTP " + result.status));
      err.data = result.data;
      err.status = result.status;
      throw err;
    }
    return result.data;
  }

  function isAdmin() { return !!(session && session.is_admin); }

  // ---------- screens and tabs ----------
  function showScreen(name) {
    $("#signinScreen").classList.toggle("hidden", name !== "signin");
    $("#confirmScreen").classList.toggle("hidden", name !== "confirm");
    $("#tabbar").classList.toggle("hidden", name !== "app");
    document.querySelectorAll(".view").forEach(function (v) { if (name !== "app") v.classList.add("hidden"); });
    if (name !== "app") { session = null; $("#who").textContent = ""; }
  }

  function showTab(name) {
    if (name === "clients" && !isAdmin()) name = "mailboxes";
    if (["mailboxes", "clients", "me"].indexOf(name) < 0) name = "mailboxes";
    document.querySelectorAll("#tabbar button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    $("#mailboxesView").classList.toggle("hidden", name !== "mailboxes");
    $("#clientsView").classList.toggle("hidden", name !== "clients");
    $("#meView").classList.toggle("hidden", name !== "me");
    lsSet("mtap_tab", name);
    window.scrollTo(0, 0);
    if (name === "mailboxes") loadConns();
    if (name === "clients") loadClients();
    if (name === "me") renderMe();
  }
  document.querySelectorAll("#tabbar button").forEach(function (b) {
    b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); });
  });

  async function boot() {
    var params = new URLSearchParams(location.search);
    if (params.get("login")) { showScreen("confirm"); return; }
    try {
      session = await api("/v1/me");
    } catch (e) {
      if (e.status === 401 && getKey()) { lsSet("mtap_key", ""); setMsg($("#loginMsg"), "That API key does not work any more. Sign in again.", true); }
      showScreen("signin");
      return;
    }
    showScreen("app");
    $("#who").textContent = session.email || session.name || "";
    document.querySelector("[data-tab='clients']").classList.toggle("hidden", !isAdmin());
    showTab(lsGet("mtap_tab") || "mailboxes");
  }

  // ---------- sign-in ----------
  $("#loginForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var btn = ev.target.querySelector("button");
    btn.disabled = true;
    setMsg($("#loginMsg"), "Sending...");
    try {
      var out = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: ev.target.email.value.trim() }) });
      setMsg($("#loginMsg"), out.message + " Open it on this device.");
    } catch (e) { setMsg($("#loginMsg"), e.message, true); }
    finally { btn.disabled = false; }
  });

  $("#keyForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    lsSet("mtap_key", ev.target.key.value.trim());
    ev.target.key.value = "";
    setMsg($("#loginMsg"), "");
    boot();
  });

  $("#confirmBtn").addEventListener("click", async function () {
    var btn = $("#confirmBtn");
    btn.disabled = true;
    setMsg($("#confirmMsg"), "Signing in...");
    try {
      var token = new URLSearchParams(location.search).get("login");
      await api("/auth/confirm", { method: "POST", body: JSON.stringify({ token: token }) });
      lsSet("mtap_key", "");
      history.replaceState(null, "", "/");
      boot();
    } catch (e) {
      setMsg($("#confirmMsg"), e.message, true);
      history.replaceState(null, "", "/");
      setTimeout(function () { showScreen("signin"); }, 2500);
    } finally { btn.disabled = false; }
  });

  $("#signOut").addEventListener("click", async function () {
    try { await apiResult("/auth/logout", { method: "POST" }); } catch (e) {}
    lsSet("mtap_key", "");
    lsSet("mtap_tab", "");
    showScreen("signin");
  });

  // ---------- key sheet ----------
  function showKey(title, payload) {
    $("#sheetTitle").textContent = title;
    $("#sheetKey").textContent = payload.api_key;
    $("#sheetText").textContent = "Copy it now. It is shown only once. Scopes: " + ((payload.scopes || []).join(", ") || "none");
    $("#sheetBg").classList.remove("hidden");
  }
  $("#copyKey").addEventListener("click", function () {
    var text = $("#sheetKey").textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { toast("Copied"); })
      .catch(function () { toast("Copy did not work. Press and hold the key to select it."); });
  });
  $("#closeSheet").addEventListener("click", function () {
    $("#sheetBg").classList.add("hidden");
    $("#sheetKey").textContent = "";
  });

  // ---------- me ----------
  function renderMe() {
    if (!session) return;
    $("#meName").textContent = session.name || "Account";
    $("#meFacts").innerHTML =
      "<dt>Email</dt><dd>" + esc(session.email || "not set") + "</dd>" +
      "<dt>Tier</dt><dd>" + esc(session.tier) + "</dd>" +
      "<dt>Signed in</dt><dd>" + (session.via === "session" ? "by email link" : "with an API key") + "</dd>" +
      "<dt>Role</dt><dd>" + (isAdmin() ? "admin" : "user") + "</dd>";
  }
  $("#rotateMine").addEventListener("click", async function () {
    if (!confirm("Make a new API key? All current keys of this account stop working, including the keys your programs use.")) return;
    var btn = $("#rotateMine");
    btn.disabled = true;
    try {
      var out = await api("/v1/me/api-key/rotate", { method: "POST" });
      if (getKey()) lsSet("mtap_key", out.api_key);
      showKey("New API key", out);
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; }
  });

  // ---------- mailboxes ----------
  function setMailboxResult(id, title, result) {
    mailboxResults[id] = { title: title, result: result };
    var box = document.querySelector("[data-result='" + id + "']");
    if (box) box.outerHTML = renderResult(id);
  }

  function renderResult(id) {
    var entry = mailboxResults[id];
    if (!entry) return "<div data-result='" + esc(id) + "'></div>";
    var r = entry.result || {};
    var body = (r.connection_test && r.connection_test.body) || r.body || {};
    var summary = r.pending ? "Working..." : body.ok ? "OK" : (body.error || r.error || "Failed");
    return "<div class='result' data-result='" + esc(id) + "' aria-live='polite'>" +
      "<div class='result-head'><span>" + esc(entry.title) + ": " + esc(summary) + "</span>" +
      "<button class='ghost' data-close-result='" + esc(id) + "' type='button'>Close</button></div>" +
      (r.pending ? "" : "<details><summary class='small'>Show JSON</summary><pre>" + esc(JSON.stringify(r, null, 2)) + "</pre></details>") +
      "</div>";
  }

  function renderConn(c) {
    var label = c.label ? "<div class='sub'>" + esc(c.label) + "</div>" : "";
    var errs = (c.last_error ? "<div class='err'>" + esc(c.last_error) + "</div>" : "") +
      (c.smtp_last_error ? "<div class='err'>SMTP: " + esc(c.smtp_last_error) + "</div>" : "");
    return "<article class='card'>" +
      "<div class='card-top'><div><div class='title'>" + esc(c.username) + "</div>" + label + "</div>" +
      badge(c.status, c.status === "active") + "</div>" +
      "<dl class='facts'>" +
      "<dt>Server</dt><dd>" + esc(c.host) + ":" + esc(c.port) + " (" + esc(c.tls_mode) + ")</dd>" +
      "<dt>Sending</dt><dd>" + (c.send_enabled ? "on" : "off") + "</dd>" +
      "<dt>Checked</dt><dd>" + esc(fmtDate(c.last_validated_at)) + "</dd>" +
      "</dl>" + errs +
      "<div class='actions'>" +
      "<button type='button' data-test='" + esc(c.id) + "'>Test</button>" +
      (c.send_enabled ? "<button type='button' class='ghost' data-test-smtp='" + esc(c.id) + "'>Test send</button>" : "") +
      "<button type='button' class='ghost' data-edit='" + esc(c.id) + "'>Edit</button>" +
      "<button type='button' class='danger' data-del='" + esc(c.id) + "'>Delete</button>" +
      "</div>" +
      "<label class='check small'><input type='checkbox' data-pull='" + esc(c.id) + "' /> Test also shows the newest email</label>" +
      renderResult(c.id) +
      "</article>";
  }

  async function loadConns() {
    var list = $("#connList");
    if (!list.children.length) list.innerHTML = "<div class='empty'>Loading...</div>";
    try {
      var out = await api("/v1/connections");
      var rows = (out && out.data) || [];
      mailboxById = {};
      rows.forEach(function (c) { mailboxById[c.id] = c; });
      list.innerHTML = rows.length
        ? rows.map(renderConn).join("")
        : "<div class='empty'>No mailboxes yet. Tap <b>+ Add</b>.</div>";
    } catch (e) {
      list.innerHTML = "<div class='err'>" + esc(e.message) + "</div>";
    }
  }

  function clearFieldError() {
    document.querySelectorAll("#addForm .field-err").forEach(function (el) { el.classList.remove("field-err"); });
  }

  // Mark the form field a 422 setup error names (host, smtp_port, ...) so the fix is obvious.
  function showFieldError(field) {
    var input = field && $("#addForm").elements[field];
    if (!input) return;
    if (field.indexOf("smtp_") === 0) $("#smtpDetails").open = true;
    input.closest("label").classList.add("field-err");
    input.focus();
  }

  function openMailboxForm(show) {
    $("#mailboxListWrap").classList.toggle("hidden", show);
    $("#mailboxFormWrap").classList.toggle("hidden", !show);
    window.scrollTo(0, 0);
  }

  function resetMailboxForm() {
    var f = $("#addForm");
    clearFieldError();
    editingMailboxId = null;
    $("#mailboxFormTitle").textContent = "Add mailbox";
    $("#saveMailbox").textContent = "Check & add";
    f.reset();
    $("#metaDetails").open = false;
    $("#smtpDetails").open = false;
    f.port.value = "993";
    f.provider.value = "";
    f.password.required = true;
    f.password.placeholder = "";
    f.smtp_password.placeholder = "same as IMAP";
    setMsg($("#addMsg"), "");
  }

  function editMailbox(id) {
    var c = mailboxById[id];
    if (!c) return;
    var f = $("#addForm");
    resetMailboxForm();
    editingMailboxId = id;
    $("#mailboxFormTitle").textContent = "Edit " + (c.username || "mailbox");
    $("#saveMailbox").textContent = "Check & save";
    f.label.value = c.label || "";
    f.host.value = c.host || "";
    f.port.value = c.port || 993;
    f.tls_mode.value = c.tls_mode || "ssl";
    f.allow_invalid_cert.checked = !!c.allow_invalid_cert;
    f.username.value = c.username || "";
    f.password.required = false;
    f.password.placeholder = "leave blank to keep the current password";
    f.provider.value = c.provider === "imap_generic" ? "" : c.provider || "";
    $("#metaDetails").open = !!c.label;
    f.send_enabled.checked = !!c.send_enabled;
    f.from_name.value = c.from_name || "";
    f.smtp_host.value = c.smtp_host || "";
    f.smtp_port.value = c.smtp_port || "";
    f.smtp_tls_mode.value = c.smtp_tls_mode || "";
    f.smtp_username.value = c.smtp_username || "";
    f.smtp_password.placeholder = c.smtp_password_set ? "leave blank to keep the current SMTP password" : "same as IMAP";
    $("#smtpDetails").open = !!(c.send_enabled || c.smtp_host || c.smtp_username || c.from_name);
    openMailboxForm(true);
  }

  $("#addMailboxBtn").addEventListener("click", function () { resetMailboxForm(); openMailboxForm(true); });
  $("#cancelMailbox").addEventListener("click", function () { resetMailboxForm(); openMailboxForm(false); });

  $("#addForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var f = ev.target, msg = $("#addMsg"), btn = $("#saveMailbox");
    var payload = {
      label: f.label.value || undefined,
      host: f.host.value.trim(),
      port: Number(f.port.value),
      tls_mode: f.tls_mode.value,
      allow_invalid_cert: f.allow_invalid_cert.checked,
      username: f.username.value.trim(),
      source_account: f.username.value.trim(),
      provider: f.provider.value.trim() || "imap_generic",
      send_enabled: f.send_enabled.checked
    };
    if (!editingMailboxId || f.password.value) payload.password = f.password.value;
    // Blank SMTP host/port/TLS = keep current (or the defaults); blank username/from name = clear on edit.
    if (f.smtp_host.value.trim()) payload.smtp_host = f.smtp_host.value.trim();
    if (f.smtp_port.value) payload.smtp_port = Number(f.smtp_port.value);
    if (f.smtp_tls_mode.value) payload.smtp_tls_mode = f.smtp_tls_mode.value;
    var smtpUser = f.smtp_username.value.trim(), fromName = f.from_name.value.trim();
    if (smtpUser) payload.smtp_username = smtpUser; else if (editingMailboxId) payload.smtp_username = null;
    if (fromName) payload.from_name = fromName; else if (editingMailboxId) payload.from_name = null;
    if (f.smtp_password.value) payload.smtp_password = f.smtp_password.value;
    clearFieldError();
    setMsg(msg, "Checking the mail server...");
    btn.disabled = true;
    try {
      var c = editingMailboxId
        ? await api("/v1/connections/" + editingMailboxId, { method: "PATCH", body: JSON.stringify(payload) })
        : await api("/v1/connections", { method: "POST", body: JSON.stringify(payload) });
      toast((editingMailboxId ? "Saved " : "Added ") + c.username + " (" + c.status + ")");
      resetMailboxForm();
      openMailboxForm(false);
      loadConns();
    } catch (e) {
      setMsg(msg, e.message, true);
      showFieldError(e.data && e.data.field);
    } finally { btn.disabled = false; }
  });

  $("#connList").addEventListener("click", async function (ev) {
    var btn = ev.target.closest("button"); if (!btn) return;
    var testId = btn.getAttribute("data-test"), delId = btn.getAttribute("data-del");
    var editId = btn.getAttribute("data-edit"), closeId = btn.getAttribute("data-close-result");
    var smtpTestId = btn.getAttribute("data-test-smtp");
    var label = btn.textContent;
    try {
      if (closeId) {
        delete mailboxResults[closeId];
        var box = document.querySelector("[data-result='" + closeId + "']");
        if (box) box.outerHTML = renderResult(closeId);
        return;
      }
      if (editId) { editMailbox(editId); return; }
      if (delId) {
        var c = mailboxById[delId] || {};
        if (!confirm("Delete " + (c.username || "this mailbox") + "? Its saved login is removed. Mail on the server is not touched.")) return;
        await api("/v1/connections/" + delId, { method: "DELETE" });
        toast("Deleted " + (c.username || "mailbox"));
        loadConns();
        return;
      }
      if (smtpTestId) {
        btn.disabled = true; btn.textContent = "...";
        setMailboxResult(smtpTestId, "Send test", { pending: true });
        var s = await apiResult("/v1/connections/" + smtpTestId + "/test-smtp", { method: "POST" });
        setMailboxResult(smtpTestId, "Send test (nothing sent)", {
          request: "POST /v1/connections/" + smtpTestId + "/test-smtp", status: s.status, http_ok: s.http_ok, body: s.data
        });
        return;
      }
      if (testId) {
        btn.disabled = true; btn.textContent = "...";
        setMailboxResult(testId, "Test", { pending: true });
        var t = await apiResult("/v1/connections/" + testId + "/test", { method: "POST" });
        var pull = document.querySelector("[data-pull='" + testId + "']");
        var combined = { connection_test: { request: "POST /v1/connections/" + testId + "/test", status: t.status, http_ok: t.http_ok, body: t.data } };
        if (pull && pull.checked && t.http_ok && t.data && t.data.ok) {
          var p = "/v1/messages?connection_id=" + encodeURIComponent(testId) + "&limit=1";
          var m = await apiResult(p);
          combined.latest_email_json = { request: "GET " + p, status: m.status, http_ok: m.http_ok, body: m.data };
        }
        setMailboxResult(testId, "Test", combined);
      }
    } catch (e) {
      toast(e.message);
    } finally {
      if (testId || smtpTestId) { btn.disabled = false; btn.textContent = label; }
    }
  });

  // ---------- accounts (admin) ----------
  function renderClient(client) {
    var c = client.connections || {}, k = client.api_keys || {};
    return "<article class='card'>" +
      "<div class='card-top'><div><div class='title'>" + esc(client.name) + "</div>" +
      "<div class='sub'>" + esc(client.email || "no sign-in email") + "</div></div>" +
      badge(client.tier, client.tier !== "free") + "</div>" +
      "<dl class='facts'>" +
      "<dt>Mailboxes</dt><dd>" + esc(c.active || 0) + " active of " + esc(c.total || 0) + (c.error ? ", " + esc(c.error) + " with errors" : "") + "</dd>" +
      "<dt>API keys</dt><dd>" + esc(k.active || 0) + " active</dd>" +
      "<dt>Last activity</dt><dd>" + esc(fmtDate(client.last_activity_at)) + "</dd>" +
      "</dl>" +
      "<div class='actions'>" +
      "<button type='button' class='ghost' data-email-client='" + esc(client.id) + "'>Sign-in email</button>" +
      "<button type='button' class='danger' data-rotate-client='" + esc(client.id) + "'>New API key</button>" +
      "</div></article>";
  }

  async function loadClients() {
    var list = $("#clientList");
    if (!list.children.length) list.innerHTML = "<div class='empty'>Loading...</div>";
    try {
      var out = await api("/v1/admin/clients");
      var rows = (out && out.data) || [];
      clientById = {};
      rows.forEach(function (c) { clientById[c.id] = c; });
      list.innerHTML = rows.length ? rows.map(renderClient).join("") : "<div class='empty'>No accounts yet.</div>";
    } catch (e) {
      list.innerHTML = "<div class='err'>" + esc(e.message) + "</div>";
    }
  }

  function openClientForm(show) {
    $("#clientListWrap").classList.toggle("hidden", show);
    $("#clientFormWrap").classList.toggle("hidden", !show);
    if (!show) { $("#createClientForm").reset(); setMsg($("#clientMsg"), ""); }
    window.scrollTo(0, 0);
  }
  $("#addClientBtn").addEventListener("click", function () { openClientForm(true); });
  $("#cancelClient").addEventListener("click", function () { openClientForm(false); });

  $("#createClientForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    setMsg($("#clientMsg"), "Creating...");
    try {
      var payload = { name: f.client_name.value.trim(), tier: f.tier.value };
      if (f.client_email.value.trim()) payload.email = f.client_email.value.trim();
      var out = await api("/v1/admin/clients", { method: "POST", body: JSON.stringify(payload) });
      openClientForm(false);
      showKey("API key for " + out.name, out);
      loadClients();
    } catch (e) { setMsg($("#clientMsg"), e.message, true); }
  });

  $("#clientList").addEventListener("click", async function (ev) {
    var btn = ev.target.closest("button"); if (!btn) return;
    var rotateId = btn.getAttribute("data-rotate-client"), emailId = btn.getAttribute("data-email-client");
    var client = clientById[rotateId || emailId] || {};
    try {
      if (emailId) {
        var next = prompt("Sign-in email for " + client.name + " (leave empty to turn off email sign-in)", client.email || "");
        if (next === null) return;
        await api("/v1/admin/clients/" + emailId, { method: "PATCH", body: JSON.stringify({ email: next.trim() || null }) });
        toast("Saved");
        loadClients();
        if (session && emailId === session.tenant_id) { session.email = next.trim() || null; $("#who").textContent = session.email || session.name || ""; }
      }
      if (rotateId) {
        if (!confirm("Make a new API key for " + client.name + "? All current keys of this account stop working.")) return;
        btn.disabled = true;
        var out = await api("/v1/admin/clients/" + rotateId + "/api-key/rotate", { method: "POST" });
        if (getKey() && session && rotateId === session.tenant_id) lsSet("mtap_key", out.api_key);
        showKey("New API key for " + out.client.name, out);
        loadClients();
      }
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; }
  });

  boot();
</script>
</body>
</html>
`;
