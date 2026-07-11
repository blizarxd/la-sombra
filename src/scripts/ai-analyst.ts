import { runAiAnalyst } from "@/lib/ai/analyst";
import { log } from "@/lib/logger";
import { sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { runScript } from "./_runner";

/**
 * Runs the AI analyst (expert layer) once. No-ops gracefully if
 * ANTHROPIC_API_KEY is unset. The deterministic engine runs regardless — this
 * only ADDS reasoning + recommendations, and (bounded) low-level auto-tuning.
 */
runScript("ai:analyst", async (db) => {
  const result = await runAiAnalyst(db);
  if (!result) {
    log.info("[ai:analyst] no analysis produced (no API key or model declined)");
    return;
  }
  log.info(
    `[ai:analyst] done — ${result.analysis.recommendations.length} recommendations, ` +
      `${result.applied.reduce((a, x) => a + x.changes.length, 0)} auto-applied ` +
      `(${result.tokensInput}→${result.tokensOutput} tokens)`,
  );
  if (telegramConfigured()) {
    const sent = await sendTelegramMessage(result.telegramText);
    log.info(`[ai:analyst] telegram: ${sent ? "sent" : "FAILED"}`);
  }
  console.log("\n" + result.telegramText + "\n");
});
