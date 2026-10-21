import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "./database.js";
import { ensureStationCredentials, registerStationAuthRoutes } from "./station-auth.js";
import { createOperatorAuth } from "./operator-auth.js";

const PASSWORD = "ci-offline-test-password-very-long";

test("M7 operator HTTP is fail closed; sessions gate all private routes and station credentials", async () => {
  const db=openDatabase(":memory:");
  ensureStationCredentials(db);
  const app=Fastify();
  const auth=createOperatorAuth(PASSWORD);
  auth.register(app);
  registerStationAuthRoutes(app,db);
  app.post("/api/setup/reset-all", async () => ({ mutated:true }));
  app.put("/api/competition/gameplay", async () => ({ mutated:true }));
  app.get("/api/archives", async () => ({ confidential:true }));
  app.get("/api/live", async () => ({ phase:"IDLE" }));
  app.get("/api/competitions", async () => ({ competitions:[] }));
  try {
    await app.ready();
    for (const [method,url] of [
      ["GET","/api/stations/credentials"],
      ["POST","/api/setup/reset-all"],
      ["PUT","/api/competition/gameplay"],
      ["GET","/api/archives"],
    ] as const) {
      const response=await app.inject({method,url,payload:method==="GET"?undefined:{}});
      assert.equal(response.statusCode,401,`${method} ${url}: ${response.body}`);
      assert.equal(response.json().error,"OPERATOR_AUTH_REQUIRED");
    }
    assert.equal((await app.inject({method:"GET",url:"/api/live"})).statusCode,200);
    assert.equal((await app.inject({method:"GET",url:"/api/competitions"})).statusCode,200);

    const invalid=await app.inject({
      method:"POST",url:"/api/auth/login",
      payload:{password:"bad-password"},
    });
    assert.equal(invalid.statusCode,401);
    const login=await app.inject({
      method:"POST",url:"/api/auth/login",
      payload:{password:PASSWORD},
    });
    assert.equal(login.statusCode,200,login.body);
    assert.match(login.headers["set-cookie"] as string,/HttpOnly/);
    assert.match(login.headers["set-cookie"] as string,/SameSite=Strict/);
    const cookie=(login.headers["set-cookie"] as string).split(";")[0]!;
    assert.equal(auth.isAuthorized(cookie),true);
    assert.equal((await app.inject({method:"GET",url:"/api/auth/session",headers:{cookie}})).json().authenticated,true);
    assert.equal((await app.inject({method:"GET",url:"/api/auth/session"})).json().authenticated,false);

    const credentialRead=await app.inject({
      method:"GET",url:"/api/stations/credentials",headers:{cookie},
    });
    assert.equal(credentialRead.statusCode,200);
    assert.ok(credentialRead.json().teamA.token);
    assert.equal((await app.inject({
      method:"POST",url:"/api/setup/reset-all",headers:{cookie},payload:{},
    })).statusCode,200);
    assert.equal((await app.inject({
      method:"PUT",url:"/api/competition/gameplay",headers:{cookie},payload:{},
    })).statusCode,200);

    // A cookie doesn't authorize cross-site state-changing browser requests.
    assert.equal((await app.inject({
      method:"POST",url:"/api/setup/reset-all",
      headers:{cookie,"sec-fetch-site":"cross-site"},payload:{},
    })).statusCode,403);
    // Same-site alone is not enough: a sibling-domain Origin must not
    // drive admin state changes using a cookie on a shared LAN hostname.
    assert.equal((await app.inject({
      method:"POST",url:"/api/setup/reset-all",
      headers:{cookie,host:"uniquiz.local:8787",origin:"http://other.local:8787"},
      payload:{},
    })).statusCode,403);
    assert.equal((await app.inject({
      method:"POST",url:"/api/setup/reset-all",
      headers:{cookie,host:"uniquiz.local:8787",origin:"http://uniquiz.local:8787"},
      payload:{},
    })).statusCode,200);
    const logout=await app.inject({
      method:"POST",url:"/api/auth/logout",headers:{cookie},payload:{},
    });
    assert.equal(logout.statusCode,200);
    assert.match(logout.headers["set-cookie"] as string,/Max-Age=0/);
    assert.equal(auth.isAuthorized(cookie),false);
    assert.equal((await app.inject({
      method:"GET",url:"/api/stations/credentials",headers:{cookie},
    })).statusCode,401);
  } finally {
    await app.close();
    db.close();
  }
});

test("M7 operator auth rate-limits brute force and never accepts station tokens as operator cookies", async () => {
  const db=openDatabase(":memory:");
  ensureStationCredentials(db);
  const app=Fastify();
  const auth=createOperatorAuth(PASSWORD);
  auth.register(app);
  registerStationAuthRoutes(app,db);
  try {
    await app.ready();
    for (let i=0;i<5;i++) {
      const r=await app.inject({method:"POST",url:"/api/auth/login",payload:{password:"wrong"}});
      assert.equal(r.statusCode,401);
    }
    const blocked=await app.inject({
      method:"POST",url:"/api/auth/login",payload:{password:PASSWORD},
    });
    assert.equal(blocked.statusCode,429);
    const creds=await app.inject({method:"GET",url:"/api/stations/credentials"});
    assert.equal(creds.statusCode,401);
    assert.equal(auth.isAuthorized("uniquiz_operator=not-an-operator-token"),false);
    assert.throws(()=>createOperatorAuth("short"),/OPERATOR_PASSWORD_TOO_SHORT/);
  } finally {
    await app.close();db.close();
  }
});


test("6-digit station pairing is operator-issued, one-use, scoped, and rate-limited", async () => {
  const db=openDatabase(":memory:");
  ensureStationCredentials(db);
  const app=Fastify();
  createOperatorAuth(PASSWORD).register(app);
  registerStationAuthRoutes(app,db);
  try {
    const unauthorized=await app.inject({method:"POST",url:"/api/stations/a/pairing-code",payload:{}});
    assert.equal(unauthorized.statusCode,401);
    const login=await app.inject({method:"POST",url:"/api/auth/login",payload:{password:PASSWORD}});
    const cookie=(login.headers["set-cookie"] as string).split(";")[0]!;
    const issue=await app.inject({
      method:"POST",url:"/api/stations/a/pairing-code",headers:{cookie},payload:{},
    });
    assert.equal(issue.statusCode,200,issue.body);
    const code=issue.json().code as string;
    assert.match(code,/^\\d{6}$/);
    const mismatch=await app.inject({
      method:"POST",url:"/api/stations/enroll",payload:{station:"B",code},
    });
    assert.equal(mismatch.statusCode,401);
    const valid=await app.inject({
      method:"POST",url:"/api/stations/enroll",payload:{station:"A",code},
    });
    assert.equal(valid.statusCode,200,valid.body);
    assert.equal(validateStationToken(db,"A",valid.json().token),true);
    assert.equal(validateStationToken(db,"B",valid.json().token),false);
    const replay=await app.inject({
      method:"POST",url:"/api/stations/enroll",payload:{station:"A",code},
    });
    assert.equal(replay.statusCode,401);
    for(let i=0;i<3;i++) {
      const wrong=await app.inject({method:"POST",url:"/api/stations/enroll",
        payload:{station:"A",code:"999999"===code?"888888":"999999"}});
      assert.equal(wrong.statusCode,401);
    }
    assert.equal((await app.inject({method:"POST",url:"/api/stations/enroll",
      payload:{station:"A",code}})).statusCode,429);
    // A new code cannot be brute-forced by repeatedly reissuing codes.
    assert.equal((await app.inject({method:"GET",url:"/api/stations/credentials"})).statusCode,401);
  } finally { await app.close();db.close(); }
});
