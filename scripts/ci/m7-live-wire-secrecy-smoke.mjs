#!/usr/bin/env node
/**
 * Actual HTTP + real Socket.IO security smoke. Starts a disposable M7 server
 * bound to 127.0.0.1 with a synthetic SQLite DB and OSC disabled.
 *
 * Checks unauthenticated audience and impersonated-operator WebSocket clients
 * cannot see graded answers before explicit Reveal. No event hardware or
 * production data are accessed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../apps/server/dist/database.js";

const requireWeb = createRequire(
  fileURLToPath(new URL("../../apps/web/package.json", import.meta.url)),
);
const { io } = requireWeb("socket.io-client");
const root = mkdtempSync(join(tmpdir(), "uniquiz-live-secrecy-"));
const dbPath = join(root, "synthetic-live.db");
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PORT = 8798;
const base = `http://127.0.0.1:${PORT}`;
const password = "ci-local-only-operator-long-password-not-production";
let server;
let capturedLog = "";
const clients = [];

function assertPrivateAnswersMasked(snapshot, phase) {
  assert.equal(snapshot.phase, phase, `Unexpected phase: ${phase}`);
  assert.equal(snapshot.question?.correctOption ?? null, null,
    `Public answer key leaked in ${phase}`);
  assert.equal(snapshot.revealResults, null,
    `Public correct/wrong grading leaked in ${phase}`);
  const json = JSON.stringify(snapshot);
  assert.doesNotMatch(json, /"correctOption":"[ABCD]"/);
  assert.doesNotMatch(json, /"selectedOption":"[ABCD]"/);
  assert.doesNotMatch(json, /"isCorrect":(?:true|false)/);
}

async function request(path, {method = "GET", cookie, body} = {}) {
  const result = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? {cookie} : {}),
      ...(body === undefined ? {} : {"content-type":"application/json"}),
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const payload = await result.json().catch(() => ({}));
  return {status:result.status,payload,headers:result.headers};
}

async function post(path, cookie, body = {}) {
  const result = await request(path, {method:"POST",cookie,body});
  assert.equal(result.status, 200, `${path}: ${result.status} ${JSON.stringify(result.payload)}`);
  return result.payload;
}

async function connect(role, token) {
  const socket = io(base, {
    auth: {role, token:token ?? null}, transports:["websocket"],
    reconnection:false,timeout:5000,
  });
  const record = {role, socket, snapshots:[], ownSubmissions:[]};
  clients.push(record);
  socket.on("live:snapshot", (snapshot) => record.snapshots.push(snapshot));
  socket.on("live:team-submission", (payload) => record.ownSubmissions.push(payload));
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No hello for ${role}`)),5000);
    socket.once("server:hello", (payload) => {
      clearTimeout(timer);resolve(payload);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);reject(error);
    });
  });
  return {...record, hello};
}

async function waitForHttpPhase(phase) {
  for (let i=0;i<125;i++) {
    const result = await request("/api/live");
    assert.equal(result.status, 200);
    if (result.payload.phase === phase) return result.payload;
    await new Promise((done)=>setTimeout(done,40));
  }
  throw new Error(`Timed out waiting for HTTP phase ${phase}`);
}

async function waitForSocketPhase(record, phase) {
  for (let i=0;i<125;i++) {
    const matched = record.snapshots.find((snapshot)=>snapshot.phase===phase);
    if (matched) return matched;
    await new Promise((done)=>setTimeout(done,20));
  }
  throw new Error(`Missing Socket.IO ${phase} event for ${record.role}`);
}

async function sendAnswer(record, option) {
  return await new Promise((resolve, reject) => {
    const timeout=setTimeout(()=>reject(new Error("No team submission ack")),3000);
    record.socket.emit("team:submit-answer", {option}, (result) => {
      clearTimeout(timeout);resolve(result);
    });
  });
}

function seed() {
  const db=openDatabase(dbPath);
  try {
    db.exec(`
      INSERT INTO colleges(name,sort_order) VALUES
        ('Synthetic Team A',1),('Synthetic Team B',2);
      INSERT INTO participants(college_id) VALUES(1),(2);
      INSERT INTO qualification_rounds(round_order,college_a_id,college_b_id,status)
        VALUES(1,1,2,'PENDING');
      INSERT INTO categories(category_key,name,display_name,sort_order)
        VALUES('general','Synthetic General','ثقافة',1);
      UPDATE competition_rules
        SET distribution_json='[{"categoryKey":"general","questions":1}]'
        WHERE id=1;
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,
                            option_d,correct_option)
        VALUES(1,'Synthetic secret question','first','second','third','fourth','B');
      INSERT INTO qualification_round_question_sets(round_id,locked_at)
        VALUES(1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
        VALUES(1,1,1,1);
    `);
  } finally { db.close(); }
}

try {
  seed();
  server=spawn(process.execPath,["apps/server/dist/index.js"],{
    cwd:repoRoot,
    env:{
      ...process.env,
      UNIQUIZ_HOST:"127.0.0.1",
      UNIQUIZ_PORT:String(PORT),
      UNIQUIZ_DB_PATH:dbPath,
      UNIQUIZ_OPERATOR_PASSWORD:password,
      UNIQUIZ_OSC_ENABLED:"false",
      UNIQUIZ_MODE:"rehearsal",
    },
    stdio:["ignore","pipe","pipe"],
  });
  for (const stream of [server.stdout,server.stderr]) {
    stream.on("data",(chunk)=>{capturedLog=(capturedLog+String(chunk)).slice(-12000);});
  }
  let healthy=false;
  for (let i=0;i<150;i++) {
    if(server.exitCode!==null) break;
    try {
      if ((await request("/health")).status===200) {healthy=true;break;}
    } catch {}
    await new Promise((done)=>setTimeout(done,100));
  }
  assert.ok(healthy,`Isolated server failed to start:\n${capturedLog}`);
  const login=await request("/api/auth/login",{
    method:"POST", body:{password},
  });
  assert.equal(login.status,200,JSON.stringify(login.payload));
  const cookie=login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie,"Operator cookie missing");
  const secrets=await request("/api/stations/credentials",{cookie});
  assert.equal(secrets.status,200,JSON.stringify(secrets.payload));
  const credentials=secrets.payload;

  const audience=await connect("display");
  const impostor=await connect("operator");
  const teamA=await connect("team-a",credentials.teamA.token);
  const teamB=await connect("team-b",credentials.teamB.token);
  assert.equal(audience.hello.role,"display");
  assert.equal(impostor.hello.role,"unknown");
  assert.equal(teamA.hello.role,"team-a");
  assert.equal(teamB.hello.role,"team-b");

  await post("/api/live/prepare-round",cookie,{roundId:1});
  await post("/api/live/confirm-stations",cookie);
  await post("/api/live/start-round",cookie);
  await post("/api/live/prepare-question",cookie);
  await post("/api/live/start-question",cookie);

  const countdown=await waitForHttpPhase("QUESTION_COUNTDOWN");
  assertPrivateAnswersMasked(countdown,"QUESTION_COUNTDOWN");
  assert.equal(countdown.question?.prompt,null);
  assert.equal(countdown.question?.options,null);
  for(const record of [audience,impostor,teamA,teamB]) {
    const snap=await waitForSocketPhase(record,"QUESTION_COUNTDOWN");
    assertPrivateAnswersMasked(snap,"QUESTION_COUNTDOWN");
    assert.equal(snap.question?.prompt,null);
  }

  const active=await waitForHttpPhase("QUESTION_ACTIVE");
  assertPrivateAnswersMasked(active,"QUESTION_ACTIVE");
  assert.equal(active.question?.options?.B,"second");
  for(const record of [audience,impostor]) {
    const snap=await waitForSocketPhase(record,"QUESTION_ACTIVE");
    assertPrivateAnswersMasked(snap,"QUESTION_ACTIVE");
    assert.equal(snap.question?.prompt,"Synthetic secret question");
  }

  const unauthorizedAnswer=await sendAnswer(impostor,"B");
  assert.equal(unauthorizedAnswer.ok,false,
    "Unauthenticated declared operator managed to submit an answer");
  const receiptA=await sendAnswer(teamA,"B");
  assert.equal(receiptA.ok,true,JSON.stringify(receiptA));
  const afterA=await request("/api/live");
  assertPrivateAnswersMasked(afterA.payload,"QUESTION_ACTIVE");

  const receiptB=await sendAnswer(teamB,"C");
  assert.equal(receiptB.ok,true,JSON.stringify(receiptB));
  const closed=await request("/api/live");
  assertPrivateAnswersMasked(closed.payload,"QUESTION_CLOSED");
  for(const record of [audience,impostor,teamA,teamB]) {
    const snap=await waitForSocketPhase(record,"QUESTION_CLOSED");
    assertPrivateAnswersMasked(snap,"QUESTION_CLOSED");
  }
  assert.equal(impostor.ownSubmissions.length,0);
  assert.equal(audience.ownSubmissions.length,0);
  assert.ok(teamA.ownSubmissions.some((state)=>state.selectedOption==="B"));
  assert.ok(teamB.ownSubmissions.some((state)=>state.selectedOption==="C"));
  assert.ok(!teamA.ownSubmissions.some((state)=>state.selectedOption==="C"),
    "Station A was sent Station B's answer");

  await post("/api/live/reveal",cookie);
  const publishedReveal=await waitForHttpPhase("QUESTION_REVEAL");
  assert.equal(publishedReveal.question.correctOption,"B");
  assert.equal(publishedReveal.revealResults.teamA.isCorrect,true);
  assert.equal(publishedReveal.revealResults.teamB.isCorrect,false);
  for(const record of [audience,impostor]) {
    const publicReveal=await waitForSocketPhase(record,"QUESTION_REVEAL");
    assert.equal(publicReveal.question?.correctOption,"B");
  }
  console.log("M7_PUBLIC_API_AND_REAL_SOCKET_ANSWER_SECRECY_OK");
} catch(error) {
  console.error(error);
  console.error("Isolated server log:",capturedLog);
  process.exitCode=1;
} finally {
  for(const record of clients) record.socket.disconnect();
  if(server && server.exitCode===null) server.kill("SIGTERM");
  // Clean up only our uniquely created synthetic SQLite directory.
  await new Promise((done)=>setTimeout(done,150));
  rmSync(root,{recursive:true,force:true});
}
