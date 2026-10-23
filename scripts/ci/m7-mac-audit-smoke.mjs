#!/usr/bin/env node
// The real Mac offline audit entrypoint, tested on a disposable pinned M6/v12 fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repo=resolve(fileURLToPath(new URL("../..",import.meta.url)));
const root=mkdtempSync(join(tmpdir(),"uniquiz-m7-mac-audit-ci-"));
const sourceDir=join(root,"synthetic-source");
mkdirSync(sourceDir);
const source=join(sourceDir,"synthetic-m6-v12.db");
const output=join(root,"private-audit");
function run(cmd,args) {
  const p=spawnSync(cmd,args,{cwd:repo,encoding:"utf8",timeout:120000});
  assert.equal(p.status,0,cmd+" failed: "+p.stderr+"\n"+p.stdout);
  return p.stdout;
}
try {
  assert.match(run("python3",[
    "scripts/ci/m7-seed-m6-fixture.py",
    "--schema","scripts/fixtures/m6-main-schema.sql","--output",source,
  ]),/M6_EXACT_SCHEMA_FIXTURE_OK/);
  const originalHash=createHash("sha256").update(readFileSync(source)).digest("hex");
  assert.match(run("node",[
    "scripts/m7-mac-offline-audit.mjs","--source",source,"--output-parent",output,
  ]),/M7_MAC_OFFLINE_AUDIT_OK/);
  const dirs=readdirSync(output);
  assert.equal(dirs.length,1);
  const report=JSON.parse(readFileSync(join(output,dirs[0],"report-private.json"),"utf8"));
  assert.equal(report.sourceSchema,"12");
  assert.equal(report.migratedSchema,"17");
  assert.equal(report.contestantEntries,2);
  assert.equal(report.baselineRowsMatch,true);
  assert.equal(report.historicalRankingMatch,true);
  assert.equal(report.networkListenersStarted,false);
  assert.equal(report.oscMessagesSent,false);
  assert.equal(report.officialDatabaseOpenedForWrite,false);
  assert.equal(report.originalRankDigest,report.migratedRankDigest);
  assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"),originalHash);
  assert.equal(readdirSync(join(output,dirs[0],"migration-backups"))
    .filter(s=>s.endsWith(".sqlite3")).length,1);
  const unsafe=spawnSync("node",[
    "scripts/m7-mac-offline-audit.mjs","--source",source,"--output-parent",root,
  ],{cwd:repo,encoding:"utf8",timeout:30000});
  assert.notEqual(unsafe.status,0);
  assert.match(unsafe.stderr,/M7_REHEARSAL_MUST_BE_OUTSIDE_PRODUCTION_DIRECTORY/);
  console.log("M7_MAC_OFFLINE_AUDIT_SMOKE_OK");
} finally {
  rmSync(root,{recursive:true,force:true});
}
