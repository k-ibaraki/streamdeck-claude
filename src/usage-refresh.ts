import streamDeck from "@elgato/streamdeck";
import { mkdir } from "node:fs/promises";
import { USAGE_REFRESH_DIR } from "./env.js";
import { spawnCapture } from "./spawn-capture.js";

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

/** Claude Code refuses to rewrite the snapshot while it is under 5 minutes old.
 *  Firing on exactly 5 would race that floor and silently no-op every other
 *  round, stretching the effective refresh to 10 minutes — hence the margin. */
const CC_WRITE_FLOOR_MS = 5 * 60 * 1000;
export const USAGE_REFRESH_MS = CC_WRITE_FLOOR_MS + 30_000;
/** Same floor, applied before spawning: below it the child cannot change
 *  anything, so there is nothing to gain from the 3 seconds it costs. */
const SKIP_IF_FRESHER_THAN_MS = CC_WRITE_FLOOR_MS;
/** `claude -p "/usage"` measured at ~3s; well clear of that, and bounded so a
 *  wedged child can never pile up behind the interval. */
const SPAWN_TIMEOUT_MS = 30_000;

let running = false;
/** Only warn once per failure reason — this runs on a timer, and a missing
 *  `claude` on PATH would otherwise fill the log. */
let lastFailure = "";

/**
 * Runs the refresher unless one is already in flight or the snapshot is still
 * fresh. Resolves true when a refresh actually ran to completion, so the
 * caller knows a re-read is worthwhile.
 */
export async function refreshUsageCache(snapshotFetchedAtMs?: number): Promise<boolean> {
  if (running) return false;
  if (snapshotFetchedAtMs !== undefined && Date.now() - snapshotFetchedAtMs < SKIP_IF_FRESHER_THAN_MS) {
    return false;
  }
  running = true;
  try {
    await mkdir(USAGE_REFRESH_DIR, { recursive: true });
    const r = await spawnCapture("claude", ["-p", "/usage"], {
      cwd: USAGE_REFRESH_DIR,
      timeoutMs: SPAWN_TIMEOUT_MS,
    });
    if (r.code === 0 && !r.timedOut) {
      lastFailure = "";
      return true;
    }
    const reason = r.err ?? (r.timedOut ? "timed out" : `exit ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`);
    if (reason !== lastFailure) {
      lastFailure = reason;
      streamDeck.logger.warn(`usage refresh failed (${reason}) — keys will keep showing the last snapshot`);
    }
    return false;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (reason !== lastFailure) {
      lastFailure = reason;
      streamDeck.logger.warn(`usage refresh threw: ${reason}`);
    }
    return false;
  } finally {
    running = false;
  }
}
