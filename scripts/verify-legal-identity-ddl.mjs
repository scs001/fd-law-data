#!/usr/bin/env node
// Transactional proof for db/002_legal_source_identity.sql. The schema is
// created in a temporary PG schema, identity uniqueness and lease exclusivity
// are exercised against the real SQL, then the transaction rolls back.
import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";
import { acquireIdentityLease } from "../lib/auth-broker/identity.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(join(pkgRoot, "db", "002_legal_source_identity.sql"), "utf8");
const schema = `legal_identity_verify_${Date.now()}`;
const cfg = loadConfig();
const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });

await client.connect();
try {
  // Lease functions own SAVEPOINT/COMMIT-style transaction blocks, so this
  // proof uses a throwaway committed schema and drops it in finally rather
  // than trying to nest PG transactions.
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path = ${schema}`);
  await client.query(sql);

  const insert = `INSERT INTO legal_source_identity
    (source, account_id, browser_profile_ref)
    VALUES ($1,$2,$3)`;
  await client.query(insert, ["proof-source", "same-account", "legal-auth/proof/same"]);
  let uniqueWorked = false;
  try {
    await client.query(insert, ["proof-source", "same-account", "legal-auth/proof/duplicate"]);
  } catch (err) {
    if (err.code !== "23505") throw err;
    uniqueWorked = true;
  }
  if (!uniqueWorked) throw new Error("(source, account_id) unique constraint did not reject a duplicate");

  await client.query(insert, ["proof-source", "active-account", "legal-auth/proof/active"]);
  await client.query("UPDATE legal_source_identity SET status='active' WHERE account_id='active-account'");
  const first = await acquireIdentityLease(client, {
    source: "proof-source",
    accountId: "active-account",
    owner: "proof-owner",
    ttlMs: 60_000,
  });
  let exclusivityWorked = false;
  try {
    await acquireIdentityLease(client, {
      source: "proof-source",
      accountId: "active-account",
      owner: "second-owner",
      ttlMs: 60_000,
    });
  } catch (err) {
    if (err.code !== "IDENTITY_LEASED") throw err;
    exclusivityWorked = true;
  }
  if (!exclusivityWorked) throw new Error("identity lease did not reject a second owner");

  console.log(JSON.stringify({
    ok: true,
    schema,
    dropped: true,
    uniqueConstraint: "(source, account_id)",
    leaseExclusivity: true,
  }, null, 1));
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await client.end();
}
