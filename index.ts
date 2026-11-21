import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, accept, mcp-protocol-version, mcp-session-id",
};

type Member = { id: string; display_name: string };
type Row = { id: number; author_id: string; body: string; created_at: string };

const TOOLS = [
  {
    name: "list_rooms",
    description: "列出你所在的群，以及你在群里的身份。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_messages",
    description:
      "读取群消息。不带 after_id 时返回最近的消息；带上上次返回的 next_after_id 只读新消息。",
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "群 id，比如 home" },
        after_id: { type: "integer", description: "只返回 id 大于它的消息" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
      },
      required: ["room_id"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "以你自己的身份在群里发一条消息。想发表情包时，单独一行写 [sticker:名字]，名字用 list_stickers 里有的。",
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string" },
        body: { type: "string", minLength: 1, maxLength: 4000 },
      },
      required: ["room_id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "list_stickers",
    description:
      "列出群里能用的表情包：名字、什么时候用、图片地址。发的时候在 send_message 里单独一行写 [sticker:名字]。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
const rpcResult = (id: unknown, result: unknown) =>
  json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) =>
  json({ jsonrpc: "2.0", id, error: { code, message } });
const toolError = (text: string) => ({
  content: [{ type: "text", text }],
  isError: true,
});

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tokenFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const i = parts.indexOf("chat-mcp");
  return i >= 0 ? parts[i + 1] ?? null : null;
}

async function authenticate(token: string | null): Promise<Member | null> {
  if (!token || token.length < 16) return null;
  const { data } = await supabase
    .from("chat_members")
    .select("id, display_name")
    .eq("token_hash", await sha256Hex(decodeURIComponent(token)))
    .maybeSingle();
  return data ?? null;
}

async function inRoom(roomId: string, memberId: string): Promise<boolean> {
  const { data } = await supabase
    .from("chat_room_members")
    .select("room_id")
    .eq("room_id", roomId)
    .eq("member_id", memberId)
    .maybeSingle();
  return !!data;
}

async function memberNames(): Promise<Map<string, string>> {
  const { data } = await supabase.from("chat_members").select("id, display_name");
  return new Map((data ?? []).map((m) => [m.id, m.display_name]));
}

function line(m: Row, names: Map<string, string>): string {
  const t = new Date(m.created_at).toLocaleString("zh-CN", {
    timeZone: "Asia/Singapore",
    hour12: false,
  });
  return `#${m.id} [${t}] ${names.get(m.author_id) ?? m.author_id}: ${m.body}`;
}

async function callTool(name: string, args: Record<string, unknown>, me: Member) {
  if (name === "list_rooms") {
    const { data, error } = await supabase
      .from("chat_room_members")
      .select("room_id, chat_rooms(name)")
      .eq("member_id", me.id);
    if (error) throw error;
    // deno-lint-ignore no-explicit-any
    const rooms = (data ?? []).map((r: any) => ({ id: r.room_id, name: r.chat_rooms?.name ?? r.room_id }));
    const text = rooms.length
      ? `你是「${me.display_name}」。你所在的群：\n` + rooms.map((r) => `- ${r.id}（${r.name}）`).join("\n")
      : `你是「${me.display_name}」，还不在任何群里。`;
    return {
      content: [{ type: "text", text }],
      structuredContent: { me: { id: me.id, name: me.display_name }, rooms },
    };
  }

  if (name === "get_messages") {
    const roomId = String(args.room_id ?? "");
    if (!(await inRoom(roomId, me.id))) return toolError("你不在这个群里。");
    const limit = Math.min(Math.max(Number(args.limit ?? 30) || 30, 1), 100);
    const afterId = args.after_id == null ? null : Number(args.after_id);

    const base = supabase
      .from("chat_messages")
      .select("id, author_id, body, created_at")
      .eq("room_id", roomId);
    const { data, error } = afterId != null
      ? await base.gt("id", afterId).order("id", { ascending: true }).limit(limit)
      : await base.order("id", { ascending: false }).limit(limit);
    if (error) throw error;
    const rows: Row[] = afterId != null ? data ?? [] : (data ?? []).reverse();

    const names = await memberNames();
    const nextAfterId = rows.length ? rows[rows.length - 1].id : afterId;
    const text = (rows.length ? rows.map((m) => line(m, names)).join("\n") : "没有新消息。") +
      `\n\nnext_after_id: ${nextAfterId ?? "（暂无）"}`;
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        messages: rows.map((m) => ({ ...m, author_name: names.get(m.author_id) ?? m.author_id })),
        next_after_id: nextAfterId,
      },
    };
  }

  if (name === "send_message") {
    const roomId = String(args.room_id ?? "");
    const body = String(args.body ?? "").trim();
    if (!body || body.length > 4000) return toolError("消息不能为空，也不能超过 4000 字。");
    if (!(await inRoom(roomId, me.id))) return toolError("你不在这个群里。");
    const { data, error } = await supabase
      .from("chat_messages")
      .insert({ room_id: roomId, author_id: me.id, body })
      .select("id")
      .single();
    if (error) throw error;
    return {
      content: [{ type: "text", text: `已发送，消息 #${data.id}。` }],
      structuredContent: { id: data.id },
    };
  }

  if (name === "list_stickers") {
    const { data, error } = await supabase
      .from("stickers")
      .select("name, path, description")
      .order("created_at", { ascending: true });
    if (error) throw error;
    const stickers = (data ?? []).map((s) => ({
      name: s.name,
      description: s.description ?? "",
      url: supabase.storage.from("stickers").getPublicUrl(s.path).data.publicUrl,
    }));
    const text = stickers.length
      ? "能用的表情包（发的时候单独一行写 [sticker:名字]）：\n" +
        stickers.map((s) => `- ${s.name}${s.description ? "：" + s.description : ""}`).join("\n")
      : "还没有表情包。";
    return {
      content: [{ type: "text", text }],
      structuredContent: { stickers },
    };
  }

  return toolError(`没有这个工具：${name}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...CORS, Allow: "POST, OPTIONS" },
    });
  }

  const me = await authenticate(tokenFromPath(new URL(req.url).pathname));
  if (!me) return json({ error: "unauthorized" }, 401);

  // deno-lint-ignore no-explicit-any
  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, "Batch requests are not supported");

  if (msg?.id === undefined || msg?.id === null) {
    return new Response(null, { status: 202, headers: CORS });
  }

  try {
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return rpcResult(msg.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "yiyi-home-chat", version: "0.2.0" },
          instructions:
            `你在这个群里的身份是「${me.display_name}」。先用 list_rooms 找群，` +
            `用 get_messages 读消息，记住 next_after_id 下次只读新的，用 send_message 发言。` +
            `想发表情包先用 list_stickers 看有哪些，再在消息里单独一行写 [sticker:名字]。`,
        });
      }
      case "ping":
        return rpcResult(msg.id, {});
      case "tools/list":
        return rpcResult(msg.id, { tools: TOOLS });
      case "tools/call": {
        const name = msg.params?.name;
        if (!TOOLS.some((t) => t.name === name)) {
          return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        }
        return rpcResult(msg.id, await callTool(name, msg.params?.arguments ?? {}, me));
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    console.error(e);
    return rpcError(msg.id, -32603, "Internal error");
  }
});
