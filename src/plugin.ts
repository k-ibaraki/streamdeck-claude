import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { ANIMATION_FRAMES } from "./icons/index.js";
import { SlotAction } from "./slot-action.js";
import { SetupAction } from "./setup-action.js";
import { watchForReload } from "./reload-watcher.js";
import { createStateTracker } from "./state-tracker.js";
import { renderAll } from "./render-loop.js";
import { wipeAllEventLogs, wipeSessionEventLog, type SessionOrigin } from "./sessions.js";
import { killSession } from "./kill-session.js";
import { checkHooks, HOOK_FIX_HINT } from "./hook-check.js";
import {
  USAGE_SUPPORTED,
  UsageModelsAction,
  UsageSessionAction,
  UsageWeekAction,
} from "./usage-action.js";
import { invalidateUsageCache, readUsageSnapshot } from "./usage.js";
import { refreshUsageCache, USAGE_REFRESH_MS } from "./usage-refresh.js";

streamDeck.logger.setLevel(LogLevel.DEBUG);

const POLL_MS = 1000;
const ANIMATION_MS = 120;

const tracker = createStateTracker();
let frame = 0;
let slowTickRunning = false;

async function runSlowTick(): Promise<void> {
  if (slowTickRunning) return;
  slowTickRunning = true;
  try {
    const entries = await tracker.tick(slotAction.orderedActions().length);
    await renderAll(slotAction, entries, frame);
    await renderUsage();
  } catch (err) {
    streamDeck.logger.error("tick failed", err);
  } finally {
    slowTickRunning = false;
  }
}

async function refreshNow() {
  const result = await wipeAllEventLogs();
  if (result.errors.length) {
    streamDeck.logger.warn(`wipeAllEventLogs errors: ${result.errors.join("; ")}`);
  }
  // Force a re-poll + re-render so the user sees the wipe take effect immediately.
  // If a tick is already in flight, the regular interval picks up the change in <1s.
  await runSlowTick();
  return result;
}

async function resetSlot(sessionId: string, origin: SessionOrigin): Promise<void> {
  const r = await wipeSessionEventLog(sessionId, origin);
  if (!r.wiped) {
    streamDeck.logger.warn(`wipeSessionEventLog(${origin}/${sessionId}) failed: ${r.error}`);
    throw new Error(r.error ?? "wipe failed");
  }
  await runSlowTick();
}

async function killSlot(pid: number, sessionId: string, origin: SessionOrigin): Promise<void> {
  streamDeck.logger.info(`kill requested for ${origin}/${sessionId} pid=${pid}`);
  await killSession(pid, origin);
  // Refresh : l'agent passera "finished" puis disparaîtra au tick suivant.
  await runSlowTick();
}

/** Short press: page the deck down the session list, then re-render at once so
 *  the new window (and its slot badge) is the visible confirmation. */
async function advanceView(): Promise<void> {
  tracker.advanceView();
  await runSlowTick();
}

/** Pushes the current usage snapshot onto whichever usage keys are on the
 *  deck. Reading is mtime-gated in usage.ts, so calling this every tick costs
 *  a stat() in the common case. */
async function renderUsage(): Promise<void> {
  if (!usageActions.some((a) => a.hasInstances())) return;
  const snapshot = USAGE_SUPPORTED ? await readUsageSnapshot() : undefined;
  await Promise.all(usageActions.map((a) => a.render(snapshot)));
}

/** Key press on any usage key: pull a fresh snapshot if the one we have is old
 *  enough for Claude Code to replace it, then re-read and repaint all three. */
async function refreshUsage(): Promise<void> {
  await runUsageRefresh();
  invalidateUsageCache();
  await renderUsage();
}

/** Asks Claude Code to refetch its usage snapshot, but only when a usage key is
 *  actually on the deck — this spawns a process, and users who never placed one
 *  should never pay for it. */
async function runUsageRefresh(): Promise<void> {
  if (!USAGE_SUPPORTED) return;
  if (!usageActions.some((a) => a.hasInstances())) return;
  const snapshot = await readUsageSnapshot();
  if (await refreshUsageCache(snapshot?.fetchedAtMs)) {
    invalidateUsageCache();
    await renderUsage();
  }
}

const slotAction = new SlotAction(resetSlot, killSlot, advanceView);
const setupAction = new SetupAction(refreshNow);

const usageActions = [
  new UsageSessionAction(refreshUsage),
  new UsageWeekAction(refreshUsage),
  new UsageModelsAction(refreshUsage),
];

streamDeck.actions.registerAction(slotAction);
streamDeck.actions.registerAction(setupAction);
for (const usageAction of usageActions) {
  streamDeck.actions.registerAction(usageAction);
}
await streamDeck.connect();

watchForReload({ pollMs: POLL_MS });

setInterval(runSlowTick, POLL_MS);

// Claude Code only refetches its usage snapshot when something asks to see it,
// which an SDK/GUI-hosted session never does — see usage-refresh.ts.
setInterval(() => {
  runUsageRefresh().catch((err) => streamDeck.logger.error("usage refresh tick failed", err));
}, USAGE_REFRESH_MS);
runUsageRefresh().catch((err) => streamDeck.logger.error("initial usage refresh failed", err));

let animateRunning = false;
setInterval(async () => {
  if (animateRunning) return;
  animateRunning = true;
  frame = (frame + 1) % ANIMATION_FRAMES;
  // Skip render if nothing on screen needs to change frame-to-frame
  // (no animated motif AND no pulsing in-progress todo — labels are static).
  if (!tracker.needsAnimation() && !slotAction.anyKillArming()) {
    animateRunning = false;
    return;
  }
  try {
    await renderAll(slotAction, tracker.getEntries(), frame);
  } catch (err) {
    streamDeck.logger.error("animation render failed", err);
  } finally {
    animateRunning = false;
  }
}, ANIMATION_MS);

streamDeck.logger.info(`claude-sessions plugin started, polling=${POLL_MS}ms anim=${ANIMATION_MS}ms`);

// Surface stale/missing hook registration loudly — otherwise the plugin runs
// fine but renders wrong icons (e.g. a permission padlock that never clears
// because PostToolUse isn't catch-all). The Setup key also badges this.
checkHooks().then(({ ok, problems }) => {
  if (!ok) {
    streamDeck.logger.warn(`hook config check failed — ${HOOK_FIX_HINT}\n  ${problems.join("\n  ")}`);
  }
}).catch((err) => {
  streamDeck.logger.warn(`hook config check threw: ${err instanceof Error ? err.message : String(err)}`);
});
