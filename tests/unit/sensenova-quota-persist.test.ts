// Persistence paths of the SenseNova fetcher against a real database: the happy
// path must rotate the stored refresh token, and an operator replacement landing
// while the exchange is in flight must win.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(process.env.DATA_DIR || os.tmpdir(), "omniroute-sensenova-persist-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.APP_LOG_TO_FILE = "false";
process.env.STORAGE_ENCRYPTION_KEY = "sensenova-persist-synthetic-key";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const fetcher = await import("../../open-sse/services/sensenovaQuotaFetcher.ts");

const LIVE_PAYLOAD = {
  plan: { id: "plan-free", name: "Free Plan" },
  pools: [
    {
      id: "pool-default",
      name: "Default",
      pool_type: "default",
      window_5h: { limit: "120000", used: "12000", remaining: "108000", reset_at: 1794851140 },
      window_7d: { limit: "1200000", used: "120000", remaining: "1080000", reset_at: 1795456000 },
    },
  ],
};

const originalFetch = globalThis.fetch;

test.after(async () => {
  globalThis.fetch = originalFetch;
  // Close the handle first: a live SQLite file cannot be removed on Windows.
  await core.shutdownDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Row = Record<string, unknown> & { id: string; providerSpecificData?: Record<string, unknown> };

async function newConnection(refreshToken: string): Promise<Row> {
  core.resetDbInstance();
  return (await providers.createProviderConnection({
    provider: "sensenova",
    authType: "apikey",
    name: `sn-${Math.random().toString(36).slice(2, 8)}`,
    apiKey: "sk-synthetic-sensenova",
    providerSpecificData: { sensenovaRefreshToken: refreshToken },
  })) as Row;
}

test("a successful exchange writes the rotated token onto the row", async () => {
  const created = await newConnection("stored-refresh");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      return jsonResponse({
        access_token: "access-1",
        refresh_token: "rotated-1",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(created.id, created);
  assert.ok(quota, "the quota must be reported");

  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  assert.equal(stored.providerSpecificData?.sensenovaRefreshToken, "rotated-1");
  assert.equal(stored.providerSpecificData?.sensenovaAccessToken, "access-1");
});

test("an invalidation during the exchange stops the tokens from being written", async () => {
  const created = await newConnection("stored-refresh-3");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      // Same credential on the row, but the operator asked for a fresh session.
      fetcher.forgetSensenovaCredential(created.id);
      return jsonResponse({
        access_token: "access-orphan",
        refresh_token: "rotated-orphan",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(created.id, created);
  assert.equal(quota, null, "an invalidated exchange must not publish a session");

  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  assert.equal(
    stored.providerSpecificData?.sensenovaRefreshToken,
    "stored-refresh-3",
    "the invalidated exchange must not write its tokens"
  );
});

test("a credential replaced during the exchange survives and the result is dropped", async () => {
  const created = await newConnection("stored-refresh-2");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      // The operator saves a new credential while this exchange is on the wire.
      await providers.updateProviderConnection(created.id, {
        providerSpecificData: { sensenovaRefreshToken: "operator-refresh" },
      });
      return jsonResponse({
        access_token: "access-stale",
        refresh_token: "rotated-stale",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(created.id, created);
  assert.equal(quota, null, "the superseded session must not report a quota");

  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  assert.equal(stored.providerSpecificData?.sensenovaRefreshToken, "operator-refresh");
  assert.equal(stored.providerSpecificData?.sensenovaAccessToken, undefined);
});

test("an unrelated field edit during the exchange keeps the rotated token", async () => {
  const created = await newConnection("stored-refresh-4");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      // The operator edits a field that is not part of the credential: the
      // fenced write now fails, but the platform has already rotated the token,
      // so the new one has to be merged into the current row instead of dropped.
      await providers.updateProviderConnection(created.id, {
        providerSpecificData: {
          sensenovaRefreshToken: "stored-refresh-4",
          operatorNote: "kept",
        },
      });
      return jsonResponse({
        access_token: "access-4",
        refresh_token: "rotated-4",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(created.id, created);
  assert.ok(quota, "the rotated session must still be usable");

  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  assert.equal(stored.providerSpecificData?.sensenovaRefreshToken, "rotated-4");
  assert.equal(stored.providerSpecificData?.sensenovaAccessToken, "access-4");
  assert.equal(
    stored.providerSpecificData?.operatorNote,
    "kept",
    "the unrelated edit must survive"
  );
});

test("a second failed write keeps the chain anchored to the row", () => {
  const connectionId = `sn-chain-${Date.now()}`;
  // Both exchanges succeeded but neither write reached the row, which still holds R1.
  fetcher.__testing.setRotationMemory(connectionId, "R2", "R1");
  fetcher.__testing.rememberRotation(connectionId, "R3", "R2");

  assert.equal(
    fetcher.__testing.newestRefreshToken(connectionId, {
      [fetcher.SENSENOVA_PSD_REFRESH_TOKEN]: "R1",
    }),
    "R3",
    "the newest rotation must still be recognised as superseding the row's R1"
  );
});

test("an unreachable console asks for a retry, not a new password", async () => {
  const created = await newConnection("stored-refresh-5");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      return jsonResponse({ error: "server_error" }, 503);
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const usage = await fetcher.getSensenovaUsage(created);
  assert.match(String(usage.message), /unreachable/);
});

test("a rejected session asks for the password again", async () => {
  const created = await newConnection("stored-refresh-6");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      return jsonResponse({ error: "invalid_grant" }, 401);
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const usage = await fetcher.getSensenovaUsage(created);
  assert.match(String(usage.message), /re-enter the account password/);
});

test("a replaced credential is not read through the superseded access token", async () => {
  const created = await newConnection("stored-refresh-7");
  fetcher.invalidateSensenovaQuotaCache(created.id);
  // A token still inside the refresh margin: good for a moment, but the exchange
  // runs anyway, and after a replacement that token belongs to the old account.
  await providers.updateProviderConnection(created.id, {
    providerSpecificData: {
      sensenovaRefreshToken: "stored-refresh-7",
      sensenovaAccessToken: "old-access-7",
      sensenovaAccessTokenExpiresAt: Date.now() + 60_000,
    },
  });
  const row = (await providers.getProviderConnectionById(created.id)) as Row;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      await providers.updateProviderConnection(created.id, {
        providerSpecificData: { sensenovaRefreshToken: "operator-refresh-7" },
      });
      return jsonResponse({
        access_token: "access-stale-7",
        refresh_token: "rotated-stale-7",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(created.id, row);
  assert.equal(quota, null, "the superseded account must not be read through its old token");
});

test("a replacement during an outage is not read through the old access token", async () => {
  const created = await newConnection("stored-refresh-8");
  fetcher.invalidateSensenovaQuotaCache(created.id);
  await providers.updateProviderConnection(created.id, {
    providerSpecificData: {
      sensenovaRefreshToken: "stored-refresh-8",
      sensenovaAccessToken: "old-access-8",
      sensenovaAccessTokenExpiresAt: Date.now() + 60_000,
    },
  });
  const row = (await providers.getProviderConnectionById(created.id)) as Row;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      await providers.updateProviderConnection(created.id, {
        providerSpecificData: { sensenovaRefreshToken: "operator-refresh-8" },
      });
      return jsonResponse({ error: "server_error" }, 503);
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(created.id, row);
  assert.equal(quota, null, "an outage must not hide that the credential was replaced");
});

test("a rotation done by another process wins over this process's memory", async () => {
  const created = await newConnection("stored-refresh-9");
  fetcher.invalidateSensenovaQuotaCache(created.id);
  const sent: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      sent.push(String(init?.body));
      return jsonResponse({
        access_token: "access-9",
        refresh_token: "rotated-9",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  assert.ok(await fetcher.fetchSensenovaQuota(created.id, created));
  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  assert.equal(stored.providerSpecificData?.sensenovaRefreshToken, "rotated-9");

  // Another instance rotates the shared row while this process still remembers
  // the token it wrote.
  await providers.updateProviderConnection(created.id, {
    providerSpecificData: { sensenovaRefreshToken: "other-process-refresh" },
  });
  const row = (await providers.getProviderConnectionById(created.id)) as Row;
  const chosen = fetcher.__testing.newestRefreshToken(
    created.id,
    (row.providerSpecificData ?? {}) as Record<string, unknown>
  );
  assert.equal(
    chosen,
    "other-process-refresh",
    "a token written by another process must win over this process's memory"
  );
});

test("invalidating the reading keeps a rotation that only lives in memory", async () => {
  const created = await newConnection("stored-refresh-11");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      return jsonResponse({
        access_token: "access-11",
        refresh_token: "rotated-11",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  assert.ok(await fetcher.fetchSensenovaQuota(created.id, created));
  assert.ok(fetcher.__testing.hasRotationMemory(created.id));
  // A 429 hook or a manual refresh invalidates the reading, not the credential.
  fetcher.invalidateSensenovaQuotaCache(created.id);
  assert.ok(
    fetcher.__testing.hasRotationMemory(created.id),
    "the quota cache being cleared must not discard the rotated token"
  );
});

test("a reading invalidation during the exchange keeps the rotated token", async () => {
  const created = await newConnection("stored-refresh-12");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      // A 429 or an exhausted plan clears the reading while the exchange is on the
      // wire; the tokens it just obtained are still the account's only live pair.
      fetcher.invalidateSensenovaQuotaCache(created.id);
      return jsonResponse({
        access_token: "access-12",
        refresh_token: "rotated-12",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  await fetcher.fetchSensenovaQuota(created.id, created);

  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  assert.equal(
    stored.providerSpecificData?.sensenovaRefreshToken,
    "rotated-12",
    "clearing the reading must not throw away the rotation the platform just issued"
  );
});

test("a caller with no credential fields still lands its rotation", async () => {
  const created = await newConnection("stored-refresh-anchor");
  // A rotation whose write failed earlier: the row still holds the chain's anchor.
  fetcher.__testing.setRotationMemory(created.id, "rotated-anchor-2", "stored-refresh-anchor");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      sent.push(new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "");
      return jsonResponse({
        access_token: "access-anchor-3",
        refresh_token: "rotated-anchor-3",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  // The shape the saturation and combo probes pass: no providerSpecificData at all.
  const quota = await fetcher.fetchSensenovaQuota(created.id, {
    id: created.id,
    provider: "sensenova",
  });

  assert.ok(quota, "the rotation must land rather than be judged a replacement");
  assert.deepEqual(sent, ["rotated-anchor-2"]);
  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  assert.equal(stored.providerSpecificData?.sensenovaRefreshToken, "rotated-anchor-3");
});

test("a replacement during the exchange forgets both memory copies", async () => {
  const created = await newConnection("stored-refresh-replaced");
  fetcher.__testing.setRotationMemory(created.id, "rotated-before", "stored-refresh-replaced");
  fetcher.__testing.setAccessMemory(
    created.id,
    "access-before",
    Date.now() + 3_600_000,
    "stored-refresh-replaced"
  );
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      // Another writer installs a different credential while the exchange is running.
      await providers.updateProviderConnection(created.id, {
        providerSpecificData: { sensenovaRefreshToken: "operator-new-refresh" },
      });
      return jsonResponse({
        access_token: "access-replaced",
        refresh_token: "rotated-replaced",
        expires_in: 10800,
      });
    }
    // The seeded access token is revoked, so the read has to exchange and reach the
    // replacement check rather than answering from the memory copy.
    return jsonResponse({ code: 1 }, 401);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(created.id, {
    providerSpecificData: { [fetcher.SENSENOVA_PSD_REFRESH_TOKEN]: "stored-refresh-replaced" },
  });

  assert.equal(quota, null, "a replaced credential must not report the previous account");
  assert.equal(
    fetcher.__testing.hasRotationMemory(created.id),
    false,
    "the superseded rotation must be forgotten"
  );
  assert.equal(
    fetcher.__testing.hasAccessMemory(created.id),
    false,
    "the superseded access token must be forgotten too"
  );
  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  assert.equal(stored.providerSpecificData?.sensenovaRefreshToken, "operator-new-refresh");
});

test("a failed write keeps the rotation in memory", async () => {
  // No row exists for this id, so the write path reports "failed" and the tokens may
  // only survive in process memory.
  const connectionId = `sn-unwritable-${Date.now()}`;
  fetcher.invalidateSensenovaQuotaCache(connectionId);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      return jsonResponse({
        access_token: "access-unwritable-1",
        refresh_token: "rotated-unwritable-1",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(connectionId, {
    providerSpecificData: { [fetcher.SENSENOVA_PSD_REFRESH_TOKEN]: "stored-refresh-unwritable" },
  });

  assert.ok(quota, "a refused write must not lose the session it just obtained");
  assert.equal(
    fetcher.__testing.newestRefreshToken(connectionId, {
      [fetcher.SENSENOVA_PSD_REFRESH_TOKEN]: "stored-refresh-unwritable",
    }),
    "rotated-unwritable-1",
    "the rotation must survive in memory when the row cannot take it"
  );
});

test("the fence accepts a rotation over this process's own earlier write", async () => {
  const created = await newConnection("stored-refresh-fence");
  // This process already wrote R2; the caller still holds the pre-rotation object.
  await providers.updateProviderConnection(created.id, {
    providerSpecificData: { sensenovaRefreshToken: "rotated-fence-2" },
  });
  fetcher.__testing.setRotationMemory(created.id, "rotated-fence-2", "stored-refresh-fence");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      sent.push(new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "");
      return jsonResponse({
        access_token: "access-fence-3",
        refresh_token: "rotated-fence-3",
        expires_in: 10800,
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(created.id, {
    providerSpecificData: { [fetcher.SENSENOVA_PSD_REFRESH_TOKEN]: "stored-refresh-fence" },
  });

  assert.ok(quota, "the rotation must land instead of being called a replacement");
  assert.deepEqual(sent, ["rotated-fence-2"]);
  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  assert.equal(
    stored.providerSpecificData?.sensenovaRefreshToken,
    "rotated-fence-3",
    "the token the exchange just received must be stored"
  );
});

test("a credential removed from the row stops the remembered rotation", async () => {
  const created = await newConnection("stored-refresh-removed");
  fetcher.__testing.setRotationMemory(created.id, "memory-rotated", "stored-refresh-removed");
  // Both maps must go: the access copy is the one a stale caller would keep serving.
  fetcher.__testing.setAccessMemory(
    created.id,
    "memory-access",
    Date.now() + 3_600_000,
    "stored-refresh-removed"
  );
  await providers.updateProviderConnection(created.id, { providerSpecificData: {} });
  fetcher.invalidateSensenovaQuotaCache(created.id);

  let tokenCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      tokenCalls += 1;
      return jsonResponse({ access_token: "a", refresh_token: "b", expires_in: 10800 });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(created.id, {
    id: created.id,
    provider: "sensenova",
  });

  assert.equal(quota, null);
  assert.equal(tokenCalls, 0, "a deleted credential must not be exchanged, let alone replayed");
  assert.equal(
    fetcher.__testing.hasRotationMemory(created.id),
    false,
    "the remembered rotation must be dropped once the row no longer carries the credential"
  );
});

test("the access chain keeps the row generation across failed writes", async () => {
  const connectionId = `sn-access-chain-${Date.now()}`;
  fetcher.__testing.setAccessMemory(connectionId, "A2", Date.now() + 3_600_000, "R1");
  // A second failed write remembers the newer token under the token just consumed.
  fetcher.__testing.rememberAccess(connectionId, "A3", Date.now() + 3_600_000, "R2");

  let tokenCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      tokenCalls += 1;
      return jsonResponse({ access_token: "a", refresh_token: "b", expires_in: 10800 });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  const quota = await fetcher.fetchSensenovaQuota(connectionId, {
    providerSpecificData: { [fetcher.SENSENOVA_PSD_REFRESH_TOKEN]: "R1" },
  });

  assert.ok(quota, "the valid memory token must read the console");
  assert.equal(tokenCalls, 0, "a token the row's R1 generation produced must not be discarded");
});

test("a non-finite lifetime on the exchange cannot mint an immortal session", async () => {
  const created = await newConnection("stored-refresh-13");
  fetcher.invalidateSensenovaQuotaCache(created.id);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === fetcher.SENSENOVA_TOKEN_URL) {
      return jsonResponse({
        access_token: "access-13",
        refresh_token: "rotated-13",
        expires_in: "Infinity",
      });
    }
    return jsonResponse(LIVE_PAYLOAD);
  }) as typeof fetch;

  assert.ok(await fetcher.fetchSensenovaQuota(created.id, created));
  const stored = (await providers.getProviderConnectionById(created.id)) as Row;
  const expiresAt = Number(stored.providerSpecificData?.sensenovaAccessTokenExpiresAt);
  // The row cannot carry Infinity (JSON stores it as null), so the check is that a
  // real, near-future deadline was written instead of nothing.
  assert.ok(Number.isFinite(expiresAt), "a non-finite lifetime must fall back to the default");
  assert.ok(expiresAt > Date.now(), "the default lifetime must produce a real deadline");
  assert.ok(expiresAt <= Date.now() + 24 * 60 * 60_000, "the deadline must be the documented TTL");
});
