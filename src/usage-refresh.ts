import streamDeck from "@elgato/streamdeck";
import { mkdir } from "node:fs/promises";
import { USAGE_REFRESH_DIR } from "./env.js";
import { spawnCapture } from "./spawn-capture.js";
import { invalidateUsageCache, readUsageSnapshot } from "./usage.js";

/**
 * Keeps `~/.claude.json` → `cachedUsageUtilization` fresh.
 *
 * Claude Code only refetches its usage snapshot when something asks to *see*
 * it (startup, `/usage`, the status line, a limit warning). Sessions driven
 * through an SDK/GUI front-end hit none of those, so the cache can sit
 * untouched for hours while usage keeps accruing — measured at 25+ minutes of
 * continuous work with no refresh at all.
 *
 * So we ask for it: `claude -p "/usage"` runs the slash command locally (no
 * model turn, ~3s) and writes the refreshed snapshot back to the config blob,
 * which `usage.ts` then reads. That keeps the plugin off the undocumented
 * `/api/oauth/usage` endpoint and away from the OAuth token in the Keychain
 * altogether.
 *
 * The one cost is a transient session file, which the CLI writes as
 * `kind:"interactive"` like any other. Running in USAGE_REFRESH_DIR is what
 * lets `sessions.ts` drop it instead of flashing a slot on the deck.
 */

/** Claude Code refuses to rewrite the snapshot while it is under 5 minutes old,
 *  so asking below that can only waste the ~3s the child costs. The margin on
 *  top keeps us clear of the floor: landing exactly on it would no-op, and
 *  because a no-op is indistinguishable from a real refresh at the call site,
 *  it would also make the staleness check below fire spurious warnings. */
const CC_WRITE_FLOOR_MS = 5 * 60 * 1000;
const REFRESH_WHEN_OLDER_THAN_MS = CC_WRITE_FLOOR_MS + 30_000;
/** `claude -p "/usage"` measured at ~3s; well clear of that, and bounded so a
 *  wedged child can never pile up behind the tick. */
const SPAWN_TIMEOUT_MS = 30_000;

let running = false;
/** When we last actually spawned. The snapshot's own age cannot carry this on
 *  its own: if there is no snapshot at all, or the child leaves it untouched,
 *  the age gate never closes and the tick would relaunch the moment the last
 *  child exited — a spawn every ~3s, forever, and silently, since warnOnce()
 *  only speaks the first time. */
let lastAttemptMs = 0;
/** Only warn once per failure reason — this is driven off the tick, and a
 *  missing `claude` on PATH would otherwise fill the log. */
let lastFailure = "";

function warnOnce(message: string): void {
  if (message === lastFailure) return;
  lastFailure = message;
  streamDeck.logger.warn(message);
}

/**
 * Refreshes the snapshot unless one is already in flight or what we have is
 * still fresh. Resolves true only when `fetchedAtMs` actually moved, so the
 * caller knows there is something new to draw.
 *
 * Reads the "before" value itself rather than taking it as an argument: the
 * comparison below is only meaningful against what is genuinely on disk at
 * spawn time, and a caller passing a value it read earlier would quietly break
 * it. `readUsageSnapshot()` is mtime-gated, so this costs a stat().
 */
export async function refreshUsageCache(): Promise<boolean> {
  if (running) return false;
  if (Date.now() - lastAttemptMs < REFRESH_WHEN_OLDER_THAN_MS) return false;
  // Claimed before the first await, not after: the tick and a key press can
  // both arrive inside one turn of the event loop, and a gap here would let
  // both through and spawn two children.
  running = true;
  try {
    const before = (await readUsageSnapshot())?.fetchedAtMs;
    if (before !== undefined && Date.now() - before < REFRESH_WHEN_OLDER_THAN_MS) {
      return false;
    }
    lastAttemptMs = Date.now();
    await mkdir(USAGE_REFRESH_DIR, { recursive: true });
    const r = await spawnCapture("claude", ["-p", "/usage"], {
      cwd: USAGE_REFRESH_DIR,
      timeoutMs: SPAWN_TIMEOUT_MS,
    });
    if (r.code === 0 && !r.timedOut) {
      // Exit 0 is not proof of a refresh: `claude -p "/usage"` returns 0 even
      // when it never reaches the API (observed with a stripped environment —
      // "Total duration (API): 0s", snapshot untouched). Since we only get here
      // when the snapshot is past Claude Code's rewrite floor, a fetchedAtMs
      // that hasn't moved means the refresh did not happen, and the keys would
      // otherwise sit on a frozen number with nothing in the log.
      invalidateUsageCache();
      const after = (await readUsageSnapshot())?.fetchedAtMs;
      if (after === undefined || after === before) {
        warnOnce('claude -p "/usage" exited 0 but left the usage snapshot untouched — keys are showing a stale reading');
        return false;
      }
      lastFailure = "";
      return true;
    }
    warnOnce(`usage refresh failed (${r.err ?? (r.timedOut ? "timed out" : `exit ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`)}) — keys will keep showing the last snapshot`);
    return false;
  } catch (err) {
    warnOnce(`usage refresh threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    running = false;
  }
}
