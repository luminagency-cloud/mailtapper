import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mailboxFromAddress, SEND_ROUTE_BODY_LIMIT } from "../smtp/send.js";
import { serviceVersion } from "../version.js";

/**
 * MCP over Streamable HTTP at POST /mcp, stateless (one server per request, no session ids).
 * Auth is the normal Bearer API key, checked by the server's onRequest hook. Each tool calls the
 * existing /v1 routes through app.inject with the caller's own key, so scopes, validation, rate
 * limits and the Sent-folder copy behave exactly as they do over plain HTTP.
 */

interface PublicConnection {
  id: string;
  label: string | null;
  username: string;
  source_account: string;
  smtp_username: string | null;
  status: string;
  send_enabled: boolean;
  from_name: string | null;
  last_error: string | null;
  smtp_last_error: string | null;
}

interface Mailbox {
  id: string;
  address: string | null;
  label: string | null;
  from_name: string | null;
  status: string;
  send_enabled: boolean;
  last_error: string | null;
}

function toMailbox(c: PublicConnection): Mailbox {
  let address: string | null = null;
  try {
    address = mailboxFromAddress({ sourceAccount: c.source_account, smtpUsername: c.smtp_username, username: c.username });
  } catch {
    // No usable From address; the send route reports the same thing if this mailbox is picked.
  }
  return {
    id: c.id, address, label: c.label, from_name: c.from_name, status: c.status,
    send_enabled: c.send_enabled, last_error: c.smtp_last_error ?? c.last_error,
  };
}

/** Pick a mailbox by id, From address or label (case-insensitive). Ambiguous or unknown -> error text. */
export function resolveMailbox(mailboxes: Mailbox[], ref: string): Mailbox | string {
  const needle = ref.trim().toLowerCase();
  const byId = mailboxes.find((m) => m.id === ref.trim());
  if (byId) return byId;
  const byAddress = mailboxes.filter((m) => m.address?.toLowerCase() === needle);
  if (byAddress.length === 1) return byAddress[0]!;
  const byLabel = mailboxes.filter((m) => m.label?.toLowerCase() === needle);
  if (byLabel.length === 1) return byLabel[0]!;
  const matches = byAddress.length > 1 ? byAddress : byLabel;
  const known = mailboxes.map((m) => m.address ?? m.id).join(", ") || "none";
  if (matches.length > 1) return `"${ref}" matches ${matches.length} mailboxes; pass the mailbox id instead.`;
  return `No mailbox matches "${ref}". Registered mailboxes: ${known}.`;
}

const textResult = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  isError,
});

const recipients = z.array(z.string()).min(1);

function buildMcpServer(app: FastifyInstance, authorization: string): McpServer {
  const server = new McpServer({ name: "mailtapper", version: serviceVersion });
  const headers = { authorization, "content-type": "application/json" };

  async function listMailboxes(): Promise<Mailbox[] | string> {
    const res = await app.inject({ method: "GET", url: "/v1/connections", headers });
    if (res.statusCode !== 200) return `Could not list mailboxes (${res.statusCode}): ${res.json().error ?? res.body}`;
    return (res.json().data as PublicConnection[]).map(toMailbox);
  }

  server.registerTool(
    "list_mailboxes",
    {
      title: "List mailboxes",
      description:
        "List the mailboxes registered in mailtapper, with each one's From address, label and whether sending is enabled. " +
        "Use it to find the mailbox to send from.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const mailboxes = await listMailboxes();
      return typeof mailboxes === "string" ? textResult(mailboxes, true) : textResult({ mailboxes });
    },
  );

  server.registerTool(
    "send_email",
    {
      title: "Send email",
      description:
        "Send one email from a registered mailbox through its own SMTP account, and file a copy in its Sent folder. " +
        "This delivers real mail and cannot be undone: show the user the mailbox, recipients, subject and body and get " +
        "their approval before calling it. The mailbox must have sending enabled.",
      inputSchema: {
        mailbox: z.string().describe("The mailbox to send from: its id, From address or label, as list_mailboxes shows them."),
        to: recipients.describe("Recipient email addresses."),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        text: z.string().optional().describe("Plain-text body. Give text, html or both."),
        html: z.string().optional(),
        reply_to: z.array(z.string()).optional(),
        in_reply_to: z.string().optional().describe("Message-ID being replied to, for threading."),
        references: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ mailbox, ...message }) => {
      const mailboxes = await listMailboxes();
      if (typeof mailboxes === "string") return textResult(mailboxes, true);
      const picked = resolveMailbox(mailboxes, mailbox);
      if (typeof picked === "string") return textResult(picked, true);

      const res = await app.inject({
        method: "POST",
        url: `/v1/connections/${picked.id}/send`,
        headers,
        payload: message,
      });
      const body = res.json();
      if (res.statusCode !== 200) return textResult(`Send failed (${res.statusCode}): ${body.error ?? res.body}`, true);
      return textResult({ ...body, from: picked.address });
    },
  );

  return server;
}

export function registerMcp(app: FastifyInstance): void {
  app.post("/mcp", { bodyLimit: SEND_ROUTE_BODY_LIMIT }, async (req, reply) => {
    const server = buildMcpServer(app, req.headers.authorization!);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.once("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error(err, "mcp request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });

  // Stateless: no server-initiated stream and no sessions to end.
  const notAllowed = async (_req: unknown, reply: FastifyReply) =>
    reply.code(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
