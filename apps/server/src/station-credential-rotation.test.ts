import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "./database.js";
import { createOperatorAuth } from "./operator-auth.js";
import {
  ensureStationCredentials,
  isStationRotationSafe,
  listStationCredentials,
  registerStationAuthRoutes,
  rotateStationToken,
  validateStationToken,
  type TeamStation,
} from "./station-auth.js";

const PASSWORD="rehearsal-ci-station-admin-password";

test("station rotation changes only requested team's token, audits action and rejects revoked token", () => {
  const db=openDatabase(":memory:");
  try {
    ensureStationCredentials(db);
    const before=listStationCredentials(db);
    const oldA=before.find((row)=>row.station==="A")!.token;
    const oldB=before.find((row)=>row.station==="B")!.token;
    assert.equal(isStationRotationSafe(db),true);
    const changed=rotateStationToken(db,"A");
    assert.equal(changed.station,"A");
    assert.notEqual(changed.token,oldA);
    assert.equal(validateStationToken(db,"A",oldA),false);
    assert.equal(validateStationToken(db,"A",changed.token),true);
    assert.equal(validateStationToken(db,"B",oldB),true);
    assert.equal((db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE event_type='STATION_CREDENTIAL_ROTATED'",
    ).get() as {count:number}).count,1);
    const payload=(db.prepare(
      "SELECT payload_json AS payload FROM audit_events WHERE event_type='STATION_CREDENTIAL_ROTATED'",
    ).get() as {payload:string}).payload;
    assert.deepEqual(JSON.parse(payload),{station:"A"});
    assert.ok(!payload.includes(changed.token),"Audit logs must never include new bearer token");
    ensureStationCredentials(db);
    assert.equal(validateStationToken(db,"A",changed.token),true);
    assert.throws(()=>rotateStationToken(db,"C" as TeamStation),/UNKNOWN_STATION/);
  } finally {db.close();}
});

test("station rotation route requires operator session and refuses changes during live round",async()=>{
  const db=openDatabase(":memory:");
  const app=Fastify();
  const revoked:TeamStation[]=[];
  try {
    ensureStationCredentials(db);
    const oldA=listStationCredentials(db).find((row)=>row.station==="A")!.token;
    const auth=createOperatorAuth(PASSWORD);
    auth.register(app);
    registerStationAuthRoutes(app,db,(station)=>revoked.push(station));
    await app.ready();
    assert.equal((await app.inject({
      method:"POST",url:"/api/stations/a/rotate",
      payload:{confirm:"ROTATE_STATION_TOKEN"},
    })).statusCode,401);
    assert.equal((await app.inject({
      method:"POST",url:"/api/stations/a/rotate",payload:{confirm:"WRONG"},
    })).statusCode,401);
    const login=await app.inject({
      method:"POST",url:"/api/auth/login",payload:{password:PASSWORD},
    });
    assert.equal(login.statusCode,200);
    const cookie=(login.headers["set-cookie"] as string).split(";")[0]!;
    assert.equal((await app.inject({
      method:"POST",url:"/api/stations/a/rotate",
      headers:{cookie},payload:{confirm:"WRONG"},
    })).statusCode,400);
    assert.equal((await app.inject({
      method:"POST",url:"/api/stations/z/rotate",
      headers:{cookie},payload:{confirm:"ROTATE_STATION_TOKEN"},
    })).statusCode,404);

    db.exec(`
      INSERT INTO colleges(name,sort_order) VALUES('Team A',1);
      INSERT INTO qualification_rounds(round_order,college_a_id,status)
      VALUES(1,1,'ACTIVE');
      UPDATE live_state SET phase='QUESTION_ACTIVE';
    `);
    assert.equal(isStationRotationSafe(db),false);
    const blocked=await app.inject({
      method:"POST",url:"/api/stations/a/rotate",
      headers:{cookie},payload:{confirm:"ROTATE_STATION_TOKEN"},
    });
    assert.equal(blocked.statusCode,409);
    assert.equal(blocked.json().error,"STATION_ROTATION_BLOCKED_BY_LIVE_SESSION");
    assert.equal(validateStationToken(db,"A",oldA),true);
    assert.equal(revoked.length,0);
    db.exec(`
      UPDATE live_state SET phase='ROUND_COMPLETE';
      UPDATE qualification_rounds SET status='COMPLETED' WHERE id=1;
    `);
    const changed=await app.inject({
      method:"POST",url:"/api/stations/a/rotate",
      headers:{cookie},payload:{confirm:"ROTATE_STATION_TOKEN"},
    });
    assert.equal(changed.statusCode,200,changed.body);
    assert.equal(changed.json().credential.station,"A");
    assert.equal(validateStationToken(db,"A",oldA),false);
    assert.equal(revoked.length,1);
    assert.deepEqual(revoked,["A"]);
    assert.equal(changed.headers["cache-control"],"no-store");
    const creds=await app.inject({method:"GET",url:"/api/stations/credentials",headers:{cookie}});
    assert.equal(creds.json().teamA.token,changed.json().credential.token);
    assert.equal((await app.inject({method:"GET",url:"/api/stations/credentials"})).statusCode,401);
  } finally {await app.close();db.close();}
});
