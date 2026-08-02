import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ConnectionInventoryCursorNotFoundError,
  ConnectionInventoryListOptionsSchema,
  ConnectionMetadataSchema,
  ConnectionRowSchema,
  MarkFailedInputSchema,
  MarkReadyInputSchema,
  UpsertPendingInputSchema,
  type ConnectionInventoryPage,
  type ConnectionRow,
  type ConnectionTransitionResult,
} from "../connector/connections/store.js";
import type { PostgreSqlRootRepositoryContext } from "./postgresql-adapter.js";
import type { ConnectorConnectionsRepository } from "./platform-repositories.js";
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from "./postgresql-repository.js";

interface Row {
  readonly connection_id: string;
  readonly public_connection_id: string | null;
  readonly connector_id: string;
  readonly source: string;
  readonly entity_id: string;
  readonly status: string;
  readonly initiated_at: unknown;
  readonly completed_at: unknown | null;
  readonly last_polled_at: unknown | null;
  readonly expires_at: unknown | null;
  readonly error_reason: string | null;
  readonly metadata_json: string | null;
  readonly auth_config_id: string | null;
  readonly vendor_account_id: string | null;
  readonly vendor_user_id: string | null;
  readonly last_verified_at: unknown | null;
  readonly terminal_cause: string | null;
}

function nullableInteger(value: unknown | null): number | null {
  return value === null ? null : safeInteger(value);
}

function rowToConnection(row: Row): ConnectionRow {
  let metadata: unknown = null;
  if (row.metadata_json !== null) {
    try {
      const candidate: unknown = JSON.parse(row.metadata_json);
      metadata =
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
          ? candidate
          : null;
    } catch {
      metadata = null;
    }
  }
  return ConnectionRowSchema.parse({
    connectionId: row.connection_id,
    publicConnectionId: row.public_connection_id,
    connectorId: row.connector_id,
    source: row.source,
    entityId: row.entity_id,
    status: row.status,
    initiatedAt: safeInteger(row.initiated_at),
    completedAt: nullableInteger(row.completed_at),
    lastPolledAt: nullableInteger(row.last_polled_at),
    expiresAt: nullableInteger(row.expires_at),
    errorReason: row.error_reason,
    metadata: ConnectionMetadataSchema.nullable().parse(metadata),
    authConfigId: row.auth_config_id,
    vendorAccountId: row.vendor_account_id,
    vendorUserId: row.vendor_user_id,
    lastVerifiedAt: nullableInteger(row.last_verified_at),
    terminalCause: row.terminal_cause,
  });
}

function transition(
  row: ConnectionRow,
  transitioned: boolean,
): ConnectionTransitionResult {
  return { ...row, transitioned };
}

export function createPostgreSqlConnectorConnectionsRepository(
  context: PostgreSqlRootRepositoryContext,
): ConnectorConnectionsRepository {
  const call = <T>(
    operation: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "connector_connections",
      operation,
      write ? "write_failed" : "read_failed",
      fn,
    );

  const find = async (
    client: Parameters<
      Parameters<typeof repositoryCall<ConnectionRow | null>>[4]
    >[0],
    id: string,
  ) => {
    const result = await client.query<Row>(
      "SELECT * FROM ownware.connector_connections WHERE connection_id = $1",
      [id],
    );
    return result.rows[0] === undefined
      ? null
      : rowToConnection(result.rows[0]);
  };

  return {
    upsertPending(input) {
      return call("upsertPending", true, async () => {
        const parsed = UpsertPendingInputSchema.parse(input);
        const initiatedAt = parsed.initiatedAt ?? Date.now();
        const metadata =
          parsed.metadata === undefined
            ? null
            : JSON.stringify(parsed.metadata);
        return withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
            [`${parsed.connectorId}:${parsed.source}`, parsed.entityId],
          );
          const existing = await find(client, parsed.connectionId);
          if (existing?.status === "pending") {
            if (
              parsed.metadata !== undefined ||
              parsed.authConfigId !== undefined ||
              parsed.vendorAccountId !== undefined ||
              parsed.vendorUserId !== undefined
            ) {
              await client.query(
                `
                UPDATE ownware.connector_connections SET
                  metadata_json = COALESCE($1, metadata_json), expires_at = COALESCE($2, expires_at),
                  auth_config_id = COALESCE($3, auth_config_id),
                  vendor_account_id = COALESCE($4, vendor_account_id),
                  vendor_user_id = COALESCE($5, vendor_user_id)
                WHERE connection_id = $6
              `,
                [
                  metadata,
                  parsed.expiresAt ?? null,
                  parsed.authConfigId ?? null,
                  parsed.vendorAccountId ?? null,
                  parsed.vendorUserId ?? null,
                  parsed.connectionId,
                ],
              );
            }
            return (await find(client, parsed.connectionId))!;
          }
          if (existing?.status === "ready") return existing;
          const live = await client.query<Row>(
            `
            SELECT * FROM ownware.connector_connections
            WHERE connector_id = $1 AND source = $2 AND entity_id = $3
              AND status IN ('pending','ready') LIMIT 1 FOR UPDATE
          `,
            [parsed.connectorId, parsed.source, parsed.entityId],
          );
          if (live.rows[0] !== undefined) return rowToConnection(live.rows[0]);
          await client.query(
            `
            INSERT INTO ownware.connector_connections (
              connection_id, public_connection_id, connector_id, source, entity_id, status,
              initiated_at, expires_at, metadata_json, auth_config_id,
              vendor_account_id, vendor_user_id
            ) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11)
          `,
            [
              parsed.connectionId,
              randomUUID(),
              parsed.connectorId,
              parsed.source,
              parsed.entityId,
              initiatedAt,
              parsed.expiresAt ?? null,
              metadata,
              parsed.authConfigId ?? null,
              parsed.vendorAccountId ?? null,
              parsed.vendorUserId ?? null,
            ],
          );
          return (await find(client, parsed.connectionId))!;
        });
      });
    },
    markReady(input) {
      return call("markReady", true, async (client) => {
        const parsed = MarkReadyInputSchema.parse(input);
        const updated = await client.query(
          `
          UPDATE ownware.connector_connections SET status='ready', completed_at=$1,
            error_reason=NULL, metadata_json=NULL,
            vendor_account_id=COALESCE(vendor_account_id,$2),
            vendor_user_id=COALESCE(vendor_user_id,$3)
          WHERE connection_id=$4 AND status='pending'
        `,
          [
            parsed.completedAt ?? Date.now(),
            parsed.vendorAccountId ?? null,
            parsed.vendorUserId ?? null,
            parsed.connectionId,
          ],
        );
        let row = await find(client, parsed.connectionId);
        if (row === null) throw new Error("connection missing");
        if (updated.rowCount !== 1 && row.status === "ready") {
          await client.query(
            `UPDATE ownware.connector_connections SET metadata_json=NULL,
            vendor_account_id=COALESCE(vendor_account_id,$1),
            vendor_user_id=COALESCE(vendor_user_id,$2)
            WHERE connection_id=$3 AND status='ready'`,
            [
              parsed.vendorAccountId ?? null,
              parsed.vendorUserId ?? null,
              parsed.connectionId,
            ],
          );
          row = (await find(client, parsed.connectionId))!;
        }
        return transition(row, updated.rowCount === 1);
      });
    },
    markFailed(input) {
      return call("markFailed", true, async (client) => {
        const parsed = MarkFailedInputSchema.parse(input);
        const result = await client.query(
          `UPDATE ownware.connector_connections
          SET status='failed', completed_at=$1, error_reason=$2, metadata_json=NULL,
              terminal_cause='failed'
          WHERE connection_id=$3 AND status='pending'`,
          [
            parsed.completedAt ?? Date.now(),
            parsed.reason,
            parsed.connectionId,
          ],
        );
        const row = await find(client, parsed.connectionId);
        if (row === null) throw new Error("connection missing");
        return transition(row, result.rowCount === 1);
      });
    },
    markExpired(connectionId, reason) {
      return call("markExpired", true, async (client) => {
        const result = await client.query(
          `UPDATE ownware.connector_connections
          SET status='expired', completed_at=$1, error_reason=$2, metadata_json=NULL,
              terminal_cause='timeout'
          WHERE connection_id=$3 AND status='pending'`,
          [Date.now(), reason ?? "Connection attempt timed out.", connectionId],
        );
        const row = await find(client, connectionId);
        return row === null ? null : transition(row, result.rowCount === 1);
      });
    },
    markUnhealthy(connectionId, reason, completedAt = Date.now()) {
      return call("markUnhealthy", true, async (client) => {
        const parsed = MarkFailedInputSchema.parse({
          connectionId,
          reason,
          completedAt,
        });
        const result = await client.query(
          `UPDATE ownware.connector_connections
          SET status='failed', completed_at=$1, error_reason=$2, metadata_json=NULL,
              terminal_cause='failed' WHERE connection_id=$3 AND status='ready'`,
          [parsed.completedAt, parsed.reason, parsed.connectionId],
        );
        const row = await find(client, connectionId);
        return row === null ? null : transition(row, result.rowCount === 1);
      });
    },
    markRevoked(connectionId, reason, confirmed = true) {
      return call("markRevoked", true, async (client) => {
        const result = await client.query(
          `UPDATE ownware.connector_connections
          SET status='expired', completed_at=$1, error_reason=$2, metadata_json=NULL,
              terminal_cause=$3 WHERE connection_id=$4 AND status IN ('pending','ready')`,
          [
            Date.now(),
            reason,
            confirmed ? "revoked" : "revocation_unconfirmed",
            connectionId,
          ],
        );
        const row = await find(client, connectionId);
        return row === null ? null : transition(row, result.rowCount === 1);
      });
    },
    touchPolled(connectionId, at = Date.now()) {
      return call("touchPolled", true, async (client) => {
        await client.query(
          "UPDATE ownware.connector_connections SET last_polled_at=$1 WHERE connection_id=$2",
          [at, connectionId],
        );
      });
    },
    touchVerified(connectionId, at = Date.now()) {
      return call("touchVerified", true, async (client) => {
        await client.query(
          "UPDATE ownware.connector_connections SET last_verified_at=$1 WHERE connection_id=$2",
          [at, connectionId],
        );
      });
    },
    findByConnectionId(connectionId) {
      return call("findByConnectionId", false, (client) =>
        find(client, connectionId),
      );
    },
    listInventory(entityId, options): Promise<ConnectionInventoryPage> {
      return call("listInventory", false, async (client) => {
        const owner = z.string().min(1).parse(entityId);
        const parsed = ConnectionInventoryListOptionsSchema.parse(options);
        const visible = `WITH ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY connector_id, source
            ORDER BY initiated_at DESC, public_connection_id DESC) AS inventory_rank
          FROM ownware.connector_connections WHERE entity_id=$1 AND public_connection_id IS NOT NULL
        ), visible AS (SELECT * FROM ranked WHERE inventory_rank=1 AND (
          status IN ('pending','ready') OR (status='failed' AND terminal_cause='failed') OR
          (status='expired' AND terminal_cause IN ('timeout','revocation_unconfirmed'))))`;
        let cursorAt: number | null = null;
        if (parsed.cursor !== undefined) {
          const cursor = await client.query<{ initiated_at: unknown }>(
            `${visible}
            SELECT initiated_at FROM visible WHERE public_connection_id=$2`,
            [owner, parsed.cursor],
          );
          if (cursor.rows[0] === undefined)
            throw new ConnectionInventoryCursorNotFoundError();
          cursorAt = safeInteger(cursor.rows[0].initiated_at);
        }
        const result = await client.query<Row>(
          `${visible} SELECT * FROM visible
          WHERE $2::bigint IS NULL OR initiated_at < $2 OR
            (initiated_at=$2 AND public_connection_id < $3)
          ORDER BY initiated_at DESC, public_connection_id DESC LIMIT $4`,
          [owner, cursorAt, parsed.cursor ?? null, parsed.limit + 1],
        );
        const values = result.rows
          .slice(0, parsed.limit)
          .map(rowToConnection)
          .map((row) => {
            if (row.publicConnectionId === null)
              throw new Error("inventory row missing public id");
            return { ...row, publicConnectionId: row.publicConnectionId };
          });
        return {
          items: values,
          nextCursor:
            result.rows.length > parsed.limit
              ? (values.at(-1)?.publicConnectionId ?? null)
              : null,
        };
      });
    },
    listActiveByStatus(source, status, entityId) {
      return call("listActiveByStatus", false, async (client) => {
        const result = await client.query<Row>(
          `SELECT * FROM ownware.connector_connections
          WHERE source=$1 AND status=$2 AND entity_id=$3 ORDER BY initiated_at`,
          [source, status, entityId],
        );
        return result.rows.map(rowToConnection);
      });
    },
    countForeignEntities(installEntityId) {
      return call("countForeignEntities", false, async (client) =>
        safeInteger(
          (
            await client.query<{ n: unknown }>(
              "SELECT COUNT(*) AS n FROM ownware.connector_connections WHERE entity_id<>$1",
              [installEntityId],
            )
          ).rows[0]!.n,
        ),
      );
    },
    findPending() {
      return call("findPending", false, async (client) =>
        (
          await client.query<Row>(
            `SELECT * FROM ownware.connector_connections WHERE status='pending' ORDER BY initiated_at`,
          )
        ).rows.map(rowToConnection),
      );
    },
    findActive(connectorId, source, entityId) {
      return call("findActive", false, async (client) => {
        const row = (
          await client.query<Row>(
            `SELECT * FROM ownware.connector_connections
          WHERE connector_id=$1 AND source=$2 AND entity_id=$3 AND status IN ('pending','ready') LIMIT 1`,
            [connectorId, source, entityId],
          )
        ).rows[0];
        return row === undefined ? null : rowToConnection(row);
      });
    },
    findLastVerifiedAt(connectorId, source) {
      return call("findLastVerifiedAt", false, async (client) => {
        const row = (
          await client.query<{ at: unknown | null }>(
            `SELECT MAX(last_verified_at) AS at
          FROM ownware.connector_connections WHERE connector_id=$1 AND source=$2`,
            [connectorId, source],
          )
        ).rows[0];
        return row?.at === null || row === undefined
          ? null
          : safeInteger(row.at);
      });
    },
    expireStaleOnBoot(now = Date.now()) {
      return call(
        "expireStaleOnBoot",
        true,
        async (client) =>
          (
            await client.query(
              `
        UPDATE ownware.connector_connections SET status='expired', completed_at=$1,
          error_reason='Connection attempt did not complete before gateway restarted. Please retry.',
          metadata_json=NULL, terminal_cause='timeout'
        WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<$1
      `,
              [now],
            )
          ).rowCount ?? 0,
      );
    },
  };
}
