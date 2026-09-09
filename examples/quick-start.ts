/**
 * Quick-start example: wrap a grammY session in validated envelopes.
 *
 * With an empty codec list the wrapper just stores your session values in
 * envelopes as-is — you do not have to write a codec to use it. Swap
 * `MemorySessionStorage` for any grammY storage adapter (Redis, MongoDB,
 * Deno KV, …); it is used here for demonstration only and loses all contents
 * when the process restarts.
 *
 * Run it as a program (supply your bot token in the `Bot` constructor):
 *
 * ```sh
 * deno run --allow-net examples/quick-start.ts
 * ```
 */
import { Bot, type Context, session, type SessionFlavor } from "grammy";
import { MemorySessionStorage } from "grammy";
import { createExtendedStorage, type SerializedEnvelope } from "../src/mod.ts";

interface SessionData {
  count: number;
}
type MyContext = Context & SessionFlavor<SessionData>;

// The backing adapter stores SerializedEnvelope values.
const backing = new MemorySessionStorage<SerializedEnvelope>();

const storage = createExtendedStorage<SessionData>({
  storage: backing,
  codecs: [], // no codecs yet: values are wrapped but otherwise unchanged
});

const bot = new Bot<MyContext>(""); // <-- your bot token
bot.use(session({ initial: (): SessionData => ({ count: 0 }), storage }));

bot.on("message", (ctx) => {
  ctx.session.count++;
  return ctx.reply(`Seen ${ctx.session.count} messages.`);
});

// Only start long-polling when run directly, so importing this file (e.g. for
// type-checking) never opens a network connection.
if (import.meta.main) {
  bot.start();
}
