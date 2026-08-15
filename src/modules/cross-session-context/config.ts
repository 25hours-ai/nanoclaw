/**
 * Cross-session context caps.
 *
 * Module-level constants for now — no DB config. Exported so the
 * router/delivery fan hooks, the host-sweep pruner, and tests share one
 * source of truth.
 */

/** channel_type stamped on fanned rows (cross-stream contract — the
 *  container formatter renders these as <cross-session-context> blocks). */
export const ECHO_CHANNEL_TYPE = 'session-echo';

/** echo.surface value stamped on same-messaging-group sibling echoes — a DM's
 *  parallel conversation-threads seeing each other (audience-subset rule: same
 *  DM = same audience). Wire contract fields stay {surface,label}; this is
 *  just a new surface value. */
export const ECHO_SIBLING_SURFACE = 'dm-thread';

/** Per-message text cap on echo rows: head-truncated, '…' appended when cut. */
export const ECHO_TEXT_MAX_CHARS = 500;

/** Pending echo rows the sweep pruner keeps per non-task session (newest first). */
export const ECHO_BACKLOG_CAP = 50;

/** Pending echo rows kept per task session — task series wake with "what
 *  happened since last run", so they get a longer horizon. */
export const ECHO_BACKLOG_CAP_TASK = 100;

/** Pending echo rows older than this are dropped regardless of the count caps. */
export const ECHO_MAX_AGE_DAYS = 7;

/** Backfill prelude surface: THIS DM's preceding timeline (first-class
 *  conversation history), distinct from live cross-thread fan echoes. */
export const ECHO_TIMELINE_SURFACE = 'dm-timeline';
