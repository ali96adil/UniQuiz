import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { registerOperatorAuth } from "./operator-auth.js";
import { ensureStationCredentials, registerStationAuthRoutes, listStationCredentials } from "./station-auth.js";
import { registerLiveSessionRoutes } from "./live-session.js";
import { registerCompetitionRoutes } from "./competition.js";
import { registerQuestionBankRoutes } from "./question-bank.js";
import { registerCompetitionArchiveRoutes } from "./competition-archives.js";
import { registerResultsExportRoutes } from "./results-export.js";

const SECRET = "CI-only-not-a-production-passphrase-strong";
async function setup() {
  const db = openDatabase(":memory:");
  ensureStationCredentials(db);
  const app = Fastify();
  const auth = registerOperatorAuth(app, SECRET);
  const io = new SocketIOServer(app.server);
  registerStationAuthRoutes(app, db);
  registerCompetitionRoutes(app, db, io);
  registerQuestionBankRoutes(app, db, io);
  registerLiveSessionRoutes(app, db, io);
  registerCompetitionArchiveRoutes(app, db);
  registerResultsExportRoutes(app, db);
  await app.ready();
  return { app, db, io, auth };
}
function sessionCookie(value: string | string[] | undefined): string {
  assert.equal(typeof value, "string");
  return (value as string).split(";")[0]!;
}
test("M7 auth: unauthenticated browsers and station token holders cannot read tokens or mutate competition", async () => {
  const {app,db,io} = await setup();
  try {
    const teamToken = listStationCredentials(db)[0]!.token;
    const endpoints: Array<{method:"GET"|"POST"|"PUT";url:string;payload?:object}> = [
      {method:"GET",url:"/api/stations/credentials"},
      {method:"GET",url:"/api/archives"},
      {method:"GET",url:"/api/export/results.xlsx"},
      {method:"GET",url:"/api/setup"},
      {method:"POST",url:"/api/live/reveal",payload:{}},
      {method:"POST",url:"/api/live/results/announce",payload:{}},
      {method:"POST",url:"/api/archives",payload:{title:"Stolen"}},
      {method:"PUT",url:"/api/competition/gameplay",payload:{durationSeconds:40,scoringMode:"fixed",correctPoints:10,pointsLostPerSecond:0}},
    ];
    for (const endpoint of endpoints) {
      const res = await app.inject({...endpoint,headers:{authorization:`Bearer ${teamToken}`}});
      assert.equal(res.statusCode,401,`${endpoint.method} ${endpoint.url}: ${res.body}`);
    }
    const publicData=await app.inject({method:"GET",url:"/api/ranking"});
    assert.equal(publicData.statusCode,404); // ranking route belongs to top-level server, not these test registrations
    assert.equal((await app.inject({method:"GET",url:"/api/live"})).statusCode,200);
    assert.equal((await app.inject({method:"GET",url:"/api/auth/status"})).json().authenticated,false);
  } finally {io.close();await app.close();db.close();}
});

test("M7 auth: operator login, strict cookie, scoped HTTP access, logout and CSRF rejection", async () => {
  const {app,db,io,auth} = await setup();
  try {
    assert.equal((await app.inject({method:"POST",url:"/api/auth/login",payload:{passphrase:"wrong-secret"}})).statusCode,401);
    const login=await app.inject({method:"POST",url:"/api/auth/login",payload:{passphrase:SECRET}});
    assert.equal(login.statusCode,200,login.body);
    const setCookie=login.headers["set-cookie"];
    assert.match(String(setCookie),/HttpOnly/);
    assert.match(String(setCookie),/SameSite=Strict/);
    const cookie=sessionCookie(setCookie);
    assert.equal(auth.authenticated(cookie),true);
    assert.equal((await app.inject({method:"GET",url:"/api/auth/status",headers:{cookie}})).json().authenticated,true);
    const tokens=await app.inject({method:"GET",url:"/api/stations/credentials",headers:{cookie}});
    assert.equal(tokens.statusCode,200);
    assert.equal(tokens.json().teamA.token,listStationCredentials(db)[0]?.token);
    const created=await app.inject({method:"POST",url:"/api/archives",headers:{cookie},payload:{title:"Test"}});
    assert.equal(created.statusCode,409,created.body); // authorized, but no rounds to archive
    const crossOrigin=await app.inject({method:"POST",url:"/api/archives",headers:{cookie,host:"quiz.local:8787",origin:"http://evil.example"},payload:{title:"Cross-site"}});
    assert.equal(crossOrigin.statusCode,403);
    const after=await app.inject({method:"POST",url:"/api/auth/logout",headers:{cookie}});
    assert.equal(after.statusCode,200);
    assert.equal(auth.authenticated(cookie),false);
    assert.equal((await app.inject({method:"GET",url:"/api/stations/credentials",headers:{cookie}})).statusCode,401);
  } finally {io.close();await app.close();db.close();}
});

test("M7 auth: brute-force attempts are limited per origin", async () => {
  const app=Fastify();
  try {
    registerOperatorAuth(app,SECRET);
    await app.ready();
    for(let i=0;i<8;i++) {
      assert.equal((await app.inject({method:"POST",url:"/api/auth/login",payload:{passphrase:"bad"}})).statusCode,401);
    }
    assert.equal((await app.inject({method:"POST",url:"/api/auth/login",payload:{passphrase:SECRET}})).statusCode,429);
  } finally {await app.close();}
});

test("M7 auth: rejects missing/short operator passphrase at initial registration", async () => {
  const app=Fastify();
  try {
    assert.throws(() => registerOperatorAuth(app,"short"),/at least 12/);
  } finally {await app.close();}
});
