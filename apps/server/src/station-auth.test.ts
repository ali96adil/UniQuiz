import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.js";
import Fastify from "fastify";
import { registerOperatorAuth } from "./operator-auth.js";
import {
  ensureStationCredentials,
  listStationCredentials,
  validateStationToken,
  createStationPairingManager,
  registerStationAuthRoutes,
  PAIRING_CODE_TTL_MS,
  STATION_SESSION_TTL_MS,
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


test("M7 pairing: single-use code yields station-bound expiring session, no permanent credential", () => {
  const db = openDatabase(":memory:");
  try {
    ensureStationCredentials(db);
    let clock = Date.now();
    const manager = createStationPairingManager(db, () => clock);
    const { code } = manager.issue("A");
    assert.match(code, /^\d{8}$/);
    assert.equal(manager.redeem("B", code, "10.0.0.2").ok, false);
    const result = manager.redeem("A", code, "10.0.0.2");
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("pairing unexpectedly rejected");
    assert.match(result.token, /^uqs1\.A\./);
    assert.notEqual(result.token, listStationCredentials(db)[0]?.token);
    assert.equal(validateStationToken(db, "A", result.token, clock), true);
    assert.equal(validateStationToken(db, "B", result.token, clock), false);
    assert.equal(validateStationToken(db, "A", result.token, clock + STATION_SESSION_TTL_MS + 1), false);
    assert.equal(manager.redeem("A", code, "10.0.0.2").ok, false);

    // Operator reissues code, making the prior unused code invalid.
    const oldCode = manager.issue("B").code;
    const newCode = manager.issue("B").code;
    assert.equal(manager.redeem("B", oldCode, "10.0.0.3").ok, false);
    assert.equal(manager.redeem("B", newCode, "10.0.0.3").ok, true);

    const expired = manager.issue("A").code;
    clock += PAIRING_CODE_TTL_MS + 1;
    assert.equal(manager.redeem("A", expired, "10.0.0.2").ok, false);
  } finally { db.close(); }
});

test("M7 pairing: failed guesses burn code attempts; different IPs cannot bypass global limit", () => {
  const db = openDatabase(":memory:");
  try {
    ensureStationCredentials(db);
    const manager = createStationPairingManager(db);
    const {code} = manager.issue("A");
    for(let n=0;n<6;n++) {
      const wrong = code === "00000000" ? "99999999" : "00000000";
      const bad = manager.redeem("A",wrong,"10.0.0."+ (n+1));
      assert.equal(bad.ok,false);
    }
    assert.equal(manager.redeem("A",code,"10.0.0.9").ok,false);

    const fresh = manager.issue("B");
    for(let n=0;n<12;n++) {
      const wrong = fresh.code === "00000000" ? "99999999" : "00000000";
      manager.redeem("B",wrong,"10.0.0.111");
      if(n===5) manager.issue("B");
    }
    const limited = manager.redeem("B", fresh.code, "10.0.0.111");
    assert.equal(limited.ok,false);
    if(!limited.ok) assert.equal(limited.status,429);
  } finally {db.close();}
});

test("M7 pairing HTTP: operator creates, anonymous station redeems once, no admin cookie required", async () => {
  const db=openDatabase(":memory:");
  const app=Fastify();
  try {
    ensureStationCredentials(db);
    registerOperatorAuth(app,"CI-PAIRING-SECRET-STRONG-NOT-FOR-REAL-USE");
    registerStationAuthRoutes(app,db);
    await app.ready();

    assert.equal((await app.inject({
      method:"POST",url:"/api/stations/pairing/create",payload:{station:"A"},
    })).statusCode,401);
    assert.equal((await app.inject({
      method:"GET",url:"/api/stations/credentials",
    })).statusCode,401);

    const login=await app.inject({
      method:"POST",url:"/api/auth/login",
      payload:{passphrase:"CI-PAIRING-SECRET-STRONG-NOT-FOR-REAL-USE"},
    });
    const cookie=String(login.headers["set-cookie"]).split(";")[0]!;
    const created=await app.inject({
      method:"POST",url:"/api/stations/pairing/create",
      headers:{cookie},
      payload:{station:"A"},
    });
    assert.equal(created.statusCode,200,created.body);
    assert.match(String(created.headers["cache-control"]),/no-store/);
    const {code}=created.json() as {code:string};
    assert.equal((await app.inject({
      method:"POST",url:"/api/stations/pairing/redeem",
      headers:{host:"quiz.local",origin:"http://untrusted.invalid"},
      payload:{station:"A",code},
    })).statusCode,403);

    const first=await app.inject({
      method:"POST",url:"/api/stations/pairing/redeem",
      payload:{station:"A",code},
    });
    assert.equal(first.statusCode,200,first.body);
    const {token}=first.json() as {token:string};
    assert.equal(validateStationToken(db,"A",token),true);
    assert.equal(validateStationToken(db,"B",token),false);
    assert.equal((await app.inject({
      method:"POST",url:"/api/stations/pairing/redeem",
      payload:{station:"A",code},
    })).statusCode,401);
  } finally {
    await app.close();db.close();
  }
});
