// The commands the dashboard knows, and their tier. The tier comes only from this list: no caller (a page, an AI
// app through /devices/mcp) can choose it, and an op that is not listed cannot be queued at all.
//   safe         queued straight away
//   destructive  waits as "proposed" until an admin confirms it on the Edge agents page
// The agent keeps the same list compiled in (agent/internal/commands) and checks every command again itself.
export type CommandTier = "safe" | "destructive";

export interface CommandOp { op: string; tier: CommandTier; what: string }

export const COMMAND_OPS: readonly CommandOp[] = [
  { op: "agent.ping", tier: "safe", what: "Ask an agent for its version, operating system and time" },
  { op: "pc.wake", tier: "safe", what: "Wake another computer on the same network: args { target }, a name from that agent's own config (the dashboard never sends a network address)" },
  { op: "pc.cancel_shutdown", tier: "safe", what: "Cancel a pending shutdown (Windows)" },
  { op: "pc.shutdown", tier: "destructive", what: "Shut a Windows PC down, args { delay_s: 10..300 }" },
];

const byName = new Map(COMMAND_OPS.map((o) => [o.op, o]));
export const commandOp = (op: string): CommandOp | undefined => byName.get(op);
