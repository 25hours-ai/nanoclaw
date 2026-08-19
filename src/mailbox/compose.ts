/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { registerAgentMailbox } from './index.js';
import { SqliteAgentMailbox } from './sqlite.js';

registerAgentMailbox(() => new SqliteAgentMailbox());
