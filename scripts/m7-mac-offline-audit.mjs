#!/usr/bin/env node
// Offline Mac migration audit. This program NEVER opens the source DB writable,
// runs a server, exposes a listening port or sends OSC.
// Requires "pnpm build"; uses the same database migration as the live server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../apps/server/dist/database.js";
import { getQualificationRanking } from "../apps/server/dist/ranking.js";

const repository=resolve(fileURLToPath(new URL("..",import.meta.url)));
const fromServer=createRequire(fileURLToPath(new URL("../apps/server/package.json",import.meta.url)));
const SQLite=fromServer("better-sqlite3");
function readArgs(argv) {
  let source=null;
  let outputParent=join(homedir(),"UniQuiz-M7-Rehearsal");
  for (let i=0; i<argv.length; i+=2) {
    const name=argv[i], value=argv[i+1];
    if (!value || (name!=="--source" && name!=="--output-parent"))
      throw new Error("Usage: node scripts/m7-mac-offline-audit.mjs --source /absolute/path/uniquiz.db [--output-parent /safe/path]");
    if (name==="--source") source=value;
    else outputParent=value;
  }
  if (!source || !isAbsolute(source) || !isAbsolute(outputParent))
    throw new Error("M7_ABSOLUTE_SOURCE_AND_OUTPUT_REQUIRED");
  return {source,outputParent};
}
function inside(parent,child) {
  const path=relative(parent,child);
  return path==="" || (path!==".." && !path.startsWith(".."+sep) && !isAbsolute(path));
}
function py(script,args) {
  const r=spawnSync("python3",[join(repository,script),...args],{
    cwd:repository,encoding:"utf8",timeout:120000,maxBuffer:4000000,
    env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},
  });
  if (r.error || r.status!==0) {
    throw new Error(script+" failed: "+(r.stderr?.trim() || r.error?.message || "unknown error"));
  }
  return r.stdout;
}
function oldRanking(rows) {
  const started=rows.filter(r=>r.roundStatus!=="PENDING")
    .sort((a,b)=>b.scoreMicros-a.scoreMicros ||
      a.totalResponseTimeMs-b.totalResponseTimeMs || a.sortOrder-b.sortOrder);
  const pending=rows.filter(r=>r.roundStatus==="PENDING")
    .sort((a,b)=>a.sortOrder-b.sortOrder);
  const college=r=>({
    id:r.collegeId,name:r.name,shortName:r.shortName,sortOrder:r.sortOrder,
  });
  return [
    ...started.map((r,i)=>({
      college:college(r),status:r.roundStatus==="COMPLETED"?"COMPLETED":"PLAYING",
      rank:i+1,scorePoints:r.scoreMicros/1000000,
      revealedQuestions:r.revealedQuestions,totalResponseTimeMs:r.totalResponseTimeMs,
      correctAnswers:r.correctAnswers,wrongAnswers:r.wrongAnswers,
    })),
    ...pending.map(r=>({
      college:college(r),status:"NOT_STARTED",rank:null,scorePoints:0,
      revealedQuestions:0,totalResponseTimeMs:0,correctAnswers:0,wrongAnswers:0,
    })),
  ];
}
function hashResults(rows) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
export function audit(sourceInput,parentInput) {
  // Only the Python WAL-aware SQLite backup helper receives the source path.
  const source=realpathSync(sourceInput);
  if (!statSync(source).isFile() || statSync(source).size===0)
    throw new Error("M7_SOURCE_DATABASE_INVALID");
  mkdirSync(parentInput,{recursive:true,mode:0o700});
  const parent=realpathSync(parentInput);
  if (inside(parent,source) || inside(dirname(source),parent))
    throw new Error("M7_REHEARSAL_MUST_BE_OUTSIDE_PRODUCTION_DIRECTORY");
  const auditDir=mkdtempSync(join(parent,"audit-"));
  const copy=join(auditDir,"rehearsal-copy.sqlite3");
  const manifest=join(auditDir,"baseline-private.json");
  try {
    assert.match(py("scripts/m7_rehearsal_copy.py",
      ["--source",source,"--destination",copy]),/REHEARSAL_COPY_OK/);
    const old=new SQLite(copy,{readonly:true,fileMustExist:true});
    let expected,sourceVersion;
    try {
      sourceVersion=old.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get()?.value;
      if (sourceVersion!=="12")
        throw new Error("M7_MAC_AUDIT_EXPECTS_M6_V12: unsupported source schema "+
          String(sourceVersion)+". Stop without changing the official database.");
      const sql=readFileSync(join(repository,"scripts/fixtures/m6-main-ranking.sql"),"utf8");
      expected=oldRanking(old.prepare(sql).all());
    } finally {
      old.close();
    }
    assert.match(py("scripts/m7_rehearsal_verify.py",
      ["capture","--database",copy,"--manifest",manifest]),/M7_BASELINE_CAPTURE_OK/);
    const db=openDatabase(copy);
    let after,version;
    try {
      after=getQualificationRanking(db).entries;
      version=db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get()?.value;
      assert.equal(version,"17","M7_SCHEMA_VERSION_UNEXPECTED");
      assert.deepEqual(db.pragma("foreign_key_check"),[],"M7_FOREIGN_KEYS_FAILED");
      assert.deepEqual(db.pragma("integrity_check"),[{integrity_check:"ok"}],"M7_INTEGRITY_FAILED");
    } finally { db.close(); }
    assert.match(py("scripts/m7_rehearsal_verify.py",
      ["verify","--database",copy,"--manifest",manifest]),/M7_REHEARSAL_VERIFY_OK/);
    assert.deepEqual(after,expected,"M7_M6_RANKING_PARITY_FAILED");
    const backupDir=join(auditDir,"migration-backups");
    const backups=existsSync(backupDir)?
      readdirSync(backupDir).filter(n=>n.endsWith(".sqlite3")):[];
    assert.ok(backups.length>0,"M7_PRE_UPGRADE_BACKUP_MISSING");
    const report={
      status:"M7_MAC_OFFLINE_AUDIT_OK",auditedAtUtc:new Date().toISOString(),
      sourceSchema:sourceVersion,migratedSchema:version,
      contestantEntries:expected.length,baselineRowsMatch:true,
      historicalRankingMatch:true,originalRankDigest:hashResults(expected),
      migratedRankDigest:hashResults(after),backupFiles:backups.length,
      networkListenersStarted:false,oscMessagesSent:false,
      officialDatabaseOpenedForWrite:false,requiresManualMacWindowsRehearsal:true,
    };
    writeFileSync(join(auditDir,"report-private.json"),
      JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
    console.log("M7_MAC_OFFLINE_AUDIT_OK");
    console.log("Preservation and historical ranking: MATCH");
    console.log("Ranking entries:",expected.length);
    console.log("Private audit directory:",auditDir);
    console.log("Actual Mac/Windows/audience/OSC rehearsal remains mandatory.");
    return report;
  } catch(error) {
    console.error("M7_MAC_OFFLINE_AUDIT_FAILED");
    console.error("Private audit directory:",auditDir);
    throw error;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  try {
    const args=readArgs(process.argv.slice(2));
    audit(args.source,args.outputParent);
  } catch(error) {
    console.error(error instanceof Error?error.message:String(error));
    process.exitCode=1;
  }
}
