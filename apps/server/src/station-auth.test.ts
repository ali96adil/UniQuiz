import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.js";
import {
  ensureStationCredentials,
  listStationCredentials,
  validateStationToken,
} from "./station-auth.js";

test("station tokens are created once and persist", () => {
  const db = openDatabase(":memory:");

  ensureStationCredentials(db);
  const first = listStationCredentials(db);

  ensureStationCredentials(db);
  const second = listStationCredentials(db);

  assert.equal(first.length, 2);
  assert.deepEqual(second, first);
  assert.notEqual(first[0]?.token, first[1]?.token);
  assert.ok((first[0]?.token.length ?? 0) >= 24);

  db.close();
});

test("station token validation binds token to the correct station", () => {
  const db = openDatabase(":memory:");
  ensureStationCredentials(db);

  const credentials = listStationCredentials(db);
  const a = credentials.find((item) => item.station === "A");
  const b = credentials.find((item) => item.station === "B");

  assert.ok(a);
  assert.ok(b);

  assert.equal(validateStationToken(db, "A", a.token), true);
  assert.equal(validateStationToken(db, "B", b.token), true);
  assert.equal(validateStationToken(db, "A", b.token), false);
  assert.equal(validateStationToken(db, "B", a.token), false);
  assert.equal(validateStationToken(db, "A", "wrong"), false);
  assert.equal(validateStationToken(db, "A", undefined), false);

  db.close();
});
