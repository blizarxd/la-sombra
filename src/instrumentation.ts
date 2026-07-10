/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * In the cloud (Railway) we use it to start the in-process operator scheduler,
 * so one service runs both the dashboard and the paper-only operator loop.
 *
 * Guarded by OPERATOR_SCHEDULER=1 and the Node.js runtime, so it never runs in
 * the Edge runtime or during local `npm run dev` unless explicitly enabled.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.OPERATOR_SCHEDULER !== "1") return;
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
