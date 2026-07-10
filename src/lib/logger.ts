/**
 * Minimal timestamped logger with secret redaction.
 * Anything that looks like a Telegram bot token or long hex secret is masked.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // telegram bot tokens
  /\b0x[a-fA-F0-9]{64}\b/g, // 64-byte hex (private-key-shaped) — never expected, but redact anyway
];

export function redact(message: string): string {
  let out = message;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token && token.length > 4) {
    out = out.split(token).join("[REDACTED]");
  }
  return out;
}

function stamp(level: string, args: unknown[]) {
  const ts = new Date().toISOString();
  const text = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  return `[${ts}] [${level}] ${redact(text)}`;
}

export const log = {
  info: (...args: unknown[]) => console.log(stamp("INFO", args)),
  warn: (...args: unknown[]) => console.warn(stamp("WARN", args)),
  error: (...args: unknown[]) => console.error(stamp("ERROR", args)),
};
