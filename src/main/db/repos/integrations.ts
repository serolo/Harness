// Integrations repository — typed CRUD over the `integrations` table (migration 0006),
// returning the `Integration` DTO declared in `src/main/integrations/index.ts` (spec §3).
// IDs are UUIDv7; timestamps are epoch-millis. The row↔DTO mapping is explicit
// (`rowToIntegration`, snake_case → camelCase) so schema drift surfaces here, mirroring
// `turns.ts` / `workspaces.ts`.
//
// SECURITY (spec §7): the DTO carries only `tokenRef` — the safeStorage ciphertext id —
// NEVER a plaintext token, and the table has no plaintext-token column either. The
// `created_at` column is intentionally NOT surfaced on the DTO (the `Integration`
// interface has no such field), so `rowToIntegration` drops it.

import { v7 as uuidv7 } from 'uuid';
import type { Integration } from '../../integrations';
import type { AppDatabase } from '../index';
import type { IntegrationsTable } from '../schema';

/**
 * Fields a caller supplies to connect an integration. `id` is generated and
 * `created_at` defaults to now; the token is already encrypted by the caller, so only
 * its `tokenRef` (safeStorage ciphertext id) is persisted — never the raw token.
 */
export interface CreateIntegrationInput {
  kind: Integration['kind'];
  accountLabel: string | null;
  tokenRef: string;
}

/**
 * Map a DB row to the `Integration` DTO (snake_case → camelCase). `created_at` is
 * dropped — the DTO has no such field.
 */
function rowToIntegration(row: IntegrationsTable): Integration {
  return {
    id: row.id,
    kind: row.kind,
    accountLabel: row.account_label,
    tokenRef: row.token_ref,
  };
}

/**
 * Repository for the `integrations` table. Constructed with the shared `AppDatabase`
 * handle.
 */
export class IntegrationsRepo {
  constructor(private readonly db: AppDatabase) {}

  /** Insert a new integration and return the created DTO. */
  async create(input: CreateIntegrationInput): Promise<Integration> {
    const row: IntegrationsTable = {
      id: uuidv7(),
      kind: input.kind,
      account_label: input.accountLabel,
      token_ref: input.tokenRef,
      created_at: Date.now(),
    };

    await this.db.insertInto('integrations').values(row).execute();
    return rowToIntegration(row);
  }

  /**
   * List connected integrations, newest first (`created_at DESC`). Optionally filtered
   * to a single `kind` (github|linear).
   */
  async list(kind?: Integration['kind']): Promise<Integration[]> {
    let query = this.db.selectFrom('integrations').selectAll();
    if (kind !== undefined) {
      query = query.where('kind', '=', kind);
    }
    // `id` (UUIDv7, time-ordered) is a deterministic tiebreaker when two rows share a
    // `created_at` millisecond — mirrors `workspaces.ts` listByProject.
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(rowToIntegration);
  }

  /** Fetch an integration by id, or `null` if none exists. */
  async getById(id: string): Promise<Integration | null> {
    const row = await this.db
      .selectFrom('integrations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToIntegration(row) : null;
  }

  /** Delete an integration row by id (a no-op if none matches). */
  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('integrations').where('id', '=', id).execute();
  }
}
