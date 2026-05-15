export function uuid(): string {
  return crypto.randomUUID();
}

// Ascending message-ID generator that mirrors opencode's
// `Identifier.ascending("message")` format
// (packages/opencode/src/id/id.ts): `msg_` + 12 hex chars encoding
// `Date.now() * 0x1000 + counter` big-endian, + 14 random base62 chars.
//
// WHY THIS EXISTS: opencode's runLoop break condition includes a STRING
// compare `lastUser.id < lastAssistant.id`. opencode's own assistant IDs
// start with `msg_e2…` in the current epoch (the high byte of
// `now * 0x1000` for 2026 timestamps). A naive `msg_<crypto.randomUUID()>`
// for the user prompt has a uniformly-random first hex char, so ~12% of
// runs the user ID sorts GREATER than opencode's assistant IDs, the
// break check stays false forever, and opencode keeps spawning empty
// assistant messages until our agentTimeoutMs aborts — looks like a
// silent hang where the model "stopped producing JSON".
//
// Generating the user ID with opencode's own format guarantees ordering:
// our Date.now() is strictly earlier than opencode's, so our 48-bit
// timestamp prefix is strictly smaller (modulo a sub-ms collision in
// which case the random tail almost certainly resolves it).
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTs = 0;
let idCounter = 0;

export function ascendingMessageId(): string {
  const now = Date.now();
  if (now !== lastIdTs) {
    lastIdTs = now;
    idCounter = 0;
  }
  idCounter += 1;
  const combined = BigInt(now) * 0x1000n + BigInt(idCounter);
  let timeHex = "";
  for (let i = 0; i < 6; i++) {
    const byte = Number((combined >> BigInt(40 - 8 * i)) & 0xffn);
    timeHex += byte.toString(16).padStart(2, "0");
  }
  const rand = new Uint8Array(14);
  crypto.getRandomValues(rand);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62[rand[i]! % 62];
  }
  return `msg_${timeHex}${randomPart}`;
}
