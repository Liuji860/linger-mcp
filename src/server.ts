import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LingerApiError, LingerClient } from "./client.js";
import { JobManager } from "./job-manager.js";

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  if (err instanceof LingerApiError) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: err.code,
              status: err.status,
              message: err.message,
              retry_after_seconds: err.retryAfterSeconds,
              request_id: err.requestId,
            },
            null,
            2
          ),
        },
      ],
    };
  }
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  };
}

export function createLingerMcpServer(client: LingerClient, jobs: JobManager): McpServer {
  const server = new McpServer({
    name: "linger-mcp",
    version: "0.1.1",
  });

  server.registerTool(
    "linger_list_agents",
    {
      description: "List available Linger agents in the workspace along with their description, model, and online availability.",
      inputSchema: {},
    },
    async () => {
      try {
        const agents = await jobs.listAgentsWithAvailability();
        return jsonResult({ agents });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "linger_ask_agent",
    {
      description:
        "Send a task or question to a Linger agent (pass display_name or actor_id directly when known). Waits up to wait_seconds (default 60s) for completion and automatically inlines readable text/Markdown document cards returned in the reply under documents. Use linger_read_document for truncated/large docs or binary files instead of asking the agent to re-paste text in chat.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent actor_id or display_name"),
        prompt: z.string().min(1).max(49_000).describe("Task instruction or question for the Linger agent"),
        room_id: z.string().min(1).optional().describe("Optional existing Linger room ID to reuse"),
        room_mode: z.enum(["bridge", "direct"]).optional().describe("Override default room mode (bridge or direct)"),
        wait_seconds: z.number().int().min(0).max(300).optional().describe("Max seconds to wait before returning async job_id (default 60)"),
      },
    },
    async (args) => {
      try {
        const snapshot = await jobs.askAgent({
          agent: args.agent,
          prompt: args.prompt,
          roomId: args.room_id,
          roomMode: args.room_mode,
          waitSeconds: args.wait_seconds,
        });
        return jsonResult(snapshot);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "linger_get_reply",
    {
      description:
        "Poll an active or pending-approval Linger job for new replies, auto-inlined documents, pending decision cards, or completion. Set wait_for_followup=true on a completed job when waiting for a follow-up async delivery from the agent.",
      inputSchema: {
        job_id: z.string().min(1).describe("Job ID returned by linger_ask_agent"),
        wait_seconds: z.number().int().min(0).max(300).optional().describe("Max seconds to wait during this poll (default 60)"),
        wait_for_followup: z
          .boolean()
          .optional()
          .describe("Set true to wait for follow-up messages/documents on an already completed job"),
      },
    },
    async (args) => {
      try {
        const snapshot = await jobs.waitForJob(args.job_id, args.wait_seconds, args.wait_for_followup ?? false);
        return jsonResult(snapshot);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "linger_decide_card",
    {
      description:
        "Submit a decision for a pending Linger card (runtime_permission approve/deny, question submit with answers, or human-confirmed relay decisions). High-risk and Linger-UI-only cards are guarded by policy.",
      inputSchema: {
        decision_id: z.string().min(1).describe("Decision ID from pending_cards"),
        decision: z.enum(["approve", "deny", "submit"]).describe("Decision action"),
        expected_version: z.number().int().min(1).optional().describe("Card version for optimistic concurrency; auto-resolved if cached"),
        comment: z.string().min(1).max(10000).optional().describe("Denial reason or note on question submission (forbidden on approve)"),
        answers: z
          .record(z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe("Map of question.id to chosen option id(s) or custom text when decision='submit'"),
        human_confirmed: z.boolean().optional().describe("Set true only when the human explicitly confirmed a relayed high-risk card in Codex"),
        room_id: z.string().min(1).optional().describe("Room ID for uncached card inspection"),
        message_id: z.string().min(1).optional().describe("Message ID for uncached card inspection"),
      },
    },
    async (args) => {
      try {
        const result = await jobs.decideCard({
          decisionId: args.decision_id,
          expectedVersion: args.expected_version,
          decision: args.decision,
          comment: args.comment,
          answers: args.answers,
          humanConfirmed: args.human_confirmed,
          roomId: args.room_id,
          messageId: args.message_id,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "linger_list_rooms",
    {
      description: "List Linger rooms the authenticated user belongs to.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Maximum rooms to return (default 50)"),
      },
    },
    async (args) => {
      try {
        const rooms = await client.listRooms(args.limit ?? 50);
        return jsonResult({ rooms });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "linger_read_document",
    {
      description:
        "Read full or paginated UTF-8 content of a Linger document/file card (from snapshot.documents, reply segments, or linger_read_room), or save binary/large files locally via save_to_file=true. Prefer this over asking the Linger agent to paste full text into chat.",
      inputSchema: {
        document_id: z.string().min(1).describe("Document ID referenced by a Linger document card or attachment"),
        document_version_id: z.string().min(1).optional().describe("Optional immutable Document Version ID"),
        offset: z.number().int().min(0).optional().describe("Character offset for paginated reads (default 0)"),
        max_chars: z.number().int().min(256).max(200_000).optional().describe("Max characters to return in one call"),
        save_to_file: z.boolean().optional().describe("Save the downloaded document locally with 0600 permissions and return saved_path"),
      },
    },
    async (args) => {
      try {
        const result = await jobs.readDocument({
          documentId: args.document_id,
          documentVersionId: args.document_version_id,
          offset: args.offset,
          maxChars: args.max_chars,
          saveToFile: args.save_to_file,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "linger_read_room",
    {
      description:
        "Read recent messages, document references, and any decision cards from a Linger room. To read the full content of a referenced document_id, call linger_read_document.",
      inputSchema: {
        room_id: z.string().min(1).describe("Room ID"),
        limit: z.number().int().min(1).max(200).optional().describe("Number of messages to read (default 20)"),
        cursor: z.string().min(1).optional().describe("Pagination cursor for older messages"),
      },
    },
    async (args) => {
      try {
        const page = await client.listMessages(args.room_id, args.limit ?? 20, args.cursor);
        return jsonResult(page);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "linger_cancel_job",
    {
      description: "Request cancellation of the active Linger Agent Run associated with a job_id.",
      inputSchema: {
        job_id: z.string().min(1).describe("Job ID to cancel"),
      },
    },
    async (args) => {
      try {
        const result = await jobs.cancelJob(args.job_id);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}
