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
type Row = { id: number; author_id: string; body: string; created_at: string; reply_to: number | null };
type Quote = { id: number; author_id: string; body: string };

const TOOLS = [
  {
    name: "list_rooms",
    description: "列出你所在的群，以及你在群里的身份。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_messages",
    description:
      "读取群消息。不带 after_id 时返回最近的消息；带上上次返回的 next_after_id 只读新消息。" +
      "有人对你做了小动作（戳戳、亲亲等）行首会标【对你】。小动作不一定是要你说话，很多时候只是闲着玩：可以戳回去、做个别的小动作，也可以不理，看上下文；配着话一起来、或者连着好多下，才更像是在叫你。（回复 #id …）表示这条是在回那条消息。",
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
      "以你自己的身份在群里发一条消息。想发表情包时，单独一行写 [sticker:名字]，名字用 list_stickers 里有的。" +
      "要回复某一条，就把它的 id 填进 reply_to。" +
      "想对谁做个小动作，就单独发一行 [互动:动作:对象]，动作是 亲亲/捏捏/戳戳/踢飞，对象是 yiyi(衣衣)/ren(蓮)/kai(小宝)，比如 [互动:亲亲:yiyi]。",
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string" },
        body: { type: "string", minLength: 1, maxLength: 4000 },
        reply_to: { type: "integer", description: "要回复的那条消息的 id（可选）" },
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
  {
    name: "add_sticker",
    description:
      "添加或修改一个表情包。带 image_base64 时上传新图；只给 name 和 description 时只改已有表情包的备注。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 20, description: "发的时候用的名字" },
        description: { type: "string", maxLength: 200, description: "图上是什么、什么时候用" },
        image_base64: { type: "string", description: "图片内容的 base64，不带 data: 前缀" },
        content_type: { type: "string", description: "比如 image/png、image/gif" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

const MAX_STICKER_BYTES = 4 * 1024 * 1024;
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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

const snippet = (body: string, n = 40) => {
  const one = body.replace(/^\[sticker:([^\]]+)\]$/gm, "[表情包] $1").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
};
const EVT = /^\[互动:([^:\]]+):([a-z]+)\]$/;
const VERB: Record<string, string> = { 亲亲: "亲了亲", 捏捏: "捏了捏", 戳戳: "戳了戳", 踢飞: "一脚踢飞了" };
const callsMe = (body: string, me: Member) => {
  const ev = body.trim().match(EVT);
  return !!ev && ev[2] === me.id;
};

function line(m: Row, names: Map<string, string>, quotes: Map<number, Quote>, me: Member): string {
  const t = new Date(m.created_at).toLocaleString("zh-CN", {
    timeZone: "Asia/Singapore",
    hour12: false,
  });
  const q = m.reply_to != null ? quotes.get(m.reply_to) : null;
  const re = m.reply_to == null ? ""
    : q ? `（回复 #${q.id} ${names.get(q.author_id) ?? q.author_id}：${snippet(q.body)}）`
    : `（回复 #${m.reply_to}）`;
  const at = m.author_id !== me.id && callsMe(m.body, me) ? "【对你】" : "";
  const ev = m.body.trim().match(EVT);
  const who = names.get(m.author_id) ?? m.author_id;
  const readable = ev ? `（${who} ${VERB[ev[1]] ?? ev[1]} ${ev[2] === me.id ? "你" : names.get(ev[2]) ?? ev[2]}）` : "";
  return `${at}#${m.id} [${t}] ${who}${re}: ${m.body}${readable}`;
}

// 蓮和小宝发言时，用 Bark 推到衣衣手机上。没配 BARK_KEY 就什么都不做。
const NOTIFY_SKIP = new Set(["yiyi"]);
async function notifyBark(me: Member, body: string) {
  const key = Deno.env.get("BARK_KEY");
  if (!key || NOTIFY_SKIP.has(me.id)) return;
  const server = (Deno.env.get("BARK_SERVER") || "https://api.day.app").replace(/\/+$/, "");
  const text = body
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^\[sticker:([^\]]+)\]$/, "[表情包] $1"))
    .join("\n")
    .slice(0, 300);
  try {
    await fetch(`${server}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        device_key: key,
        title: me.display_name,
        body: text,
        group: "我们家",
        url: Deno.env.get("BARK_OPEN_URL") || "https://kkoi111.github.io/homechat/",
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.error("bark push failed", e); // 推送失败不影响发消息
  }
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
      .select("id, author_id, body, created_at, reply_to")
      .eq("room_id", roomId);
    const { data, error } = afterId != null
      ? await base.gt("id", afterId).order("id", { ascending: true }).limit(limit)
      : await base.order("id", { ascending: false }).limit(limit);
    if (error) throw error;
    const rows: Row[] = afterId != null ? data ?? [] : (data ?? []).reverse();

    const names = await memberNames();
    // 把被回复的那几条一起查出来，方便显示引用
    const quoteIds = [...new Set(rows.map((m) => m.reply_to).filter((x): x is number => x != null))];
    const quotes = new Map<number, Quote>();
    if (quoteIds.length) {
      const { data: qs, error: qErr } = await supabase
        .from("chat_messages")
        .select("id, author_id, body")
        .eq("room_id", roomId)
        .in("id", quoteIds);
      if (qErr) throw qErr;
      for (const q of qs ?? []) quotes.set(q.id, q);
    }
    const nextAfterId = rows.length ? rows[rows.length - 1].id : afterId;
    const text = (rows.length ? rows.map((m) => line(m, names, quotes, me)).join("\n") : "没有新消息。") +
      `\n\nnext_after_id: ${nextAfterId ?? "（暂无）"}`;
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        messages: rows.map((m) => {
          const q = m.reply_to != null ? quotes.get(m.reply_to) : null;
          return {
            ...m,
            author_name: names.get(m.author_id) ?? m.author_id,
            reply: q ? { id: q.id, author_id: q.author_id, author_name: names.get(q.author_id) ?? q.author_id, body: snippet(q.body, 60) } : null,
          };
        }),
        next_after_id: nextAfterId,
      },
    };
  }

  if (name === "send_message") {
    const roomId = String(args.room_id ?? "");
    const body = String(args.body ?? "").trim();
    if (!body || body.length > 4000) return toolError("消息不能为空，也不能超过 4000 字。");
    if (!(await inRoom(roomId, me.id))) return toolError("你不在这个群里。");
    // 表情包名字写错（比如写成繁体）就退回去，别让它漏成文字
    const wanted = [...body.matchAll(/^\[sticker:([^\]]+)\]$/gm)].map((x) => x[1].trim());
    if (wanted.length) {
      const { data: known, error: kErr } = await supabase.from("stickers").select("name");
      if (kErr) throw kErr;
      const names = new Set((known ?? []).map((k) => k.name));
      const bad = wanted.filter((w) => !names.has(w));
      if (bad.length) {
        return toolError(
          `没有这些表情包：${bad.join("、")}。名字要一字不差（注意简繁体）。能用的有：${[...names].join("、")}`,
        );
      }
    }
    let replyTo: number | null = null;
    if (args.reply_to != null) {
      replyTo = Number(args.reply_to);
      const { data: target } = await supabase
        .from("chat_messages")
        .select("id")
        .eq("id", replyTo)
        .eq("room_id", roomId)
        .maybeSingle();
      if (!target) return toolError(`群里没有 #${args.reply_to} 这条消息。`);
    }
    const { data, error } = await supabase
      .from("chat_messages")
      .insert({ room_id: roomId, author_id: me.id, body, reply_to: replyTo })
      .select("id")
      .single();
    if (error) throw error;
    await notifyBark(me, body);
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

  if (name === "add_sticker") {
    const stickerName = String(args.name ?? "").trim();
    if (!stickerName || stickerName.length > 20 || /[\]\n\r\[]/.test(stickerName)) {
      return toolError("名字要 1 到 20 个字，不能有方括号或换行。");
    }
    const description = args.description == null ? null : String(args.description).trim().slice(0, 200);

    const { data: existing, error: findErr } = await supabase
      .from("stickers")
      .select("name, path, description")
      .eq("name", stickerName)
      .maybeSingle();
    if (findErr) throw findErr;

    // 只改备注
    if (args.image_base64 == null) {
      if (!existing) return toolError(`还没有叫「${stickerName}」的表情包，要上传图片才能新建。`);
      if (description == null) return toolError("没有要改的内容。");
      const { error } = await supabase.from("stickers").update({ description }).eq("name", stickerName);
      if (error) throw error;
      return {
        content: [{ type: "text", text: `已更新「${stickerName}」的备注。` }],
        structuredContent: { name: stickerName, updated: true },
      };
    }

    // 上传新图
    const contentType = String(args.content_type ?? "image/png").toLowerCase();
    const ext = EXT[contentType];
    if (!ext) return toolError("只支持 png、jpg、gif、webp。");
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(String(args.image_base64));
    } catch {
      return toolError("图片数据读不出来。");
    }
    if (!bytes.length) return toolError("图片是空的。");
    if (bytes.length > MAX_STICKER_BYTES) return toolError("图片太大了，要小于 4 MB。");

    const path = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("stickers")
      .upload(path, bytes, { contentType, upsert: false });
    if (upErr) throw upErr;

    const { error: rowErr } = await supabase
      .from("stickers")
      .upsert({ name: stickerName, path, description: description ?? existing?.description ?? "" });
    if (rowErr) {
      await supabase.storage.from("stickers").remove([path]);
      throw rowErr;
    }
    // 同名替换时，删掉旧图
    if (existing && existing.path !== path) {
      await supabase.storage.from("stickers").remove([existing.path]);
    }
    return {
      content: [{ type: "text", text: `已${existing ? "替换" : "添加"}表情包「${stickerName}」。` }],
      structuredContent: {
        name: stickerName,
        url: supabase.storage.from("stickers").getPublicUrl(path).data.publicUrl,
        replaced: !!existing,
      },
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
          serverInfo: { name: "yiyi-home-chat", version: "0.5.0" },
          instructions:
            `你在这个群里的身份是「${me.display_name}」。先用 list_rooms 找群，` +
            `用 get_messages 读消息，记住 next_after_id 下次只读新的，用 send_message 发言。` +
            `想发表情包先用 list_stickers 看有哪些，再在消息里单独一行写 [sticker:名字]。` +
            `有人对你戳戳、亲亲，不一定是要你说话，可能只是闲着玩，可以戳回去也可以不理；回复某条消息时把它的 id 填进 reply_to。`,
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
