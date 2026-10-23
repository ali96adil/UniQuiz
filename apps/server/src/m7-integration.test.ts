import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./database.js";
import {
  activeWorkspaceId,
  activateCompetitionWorkspace,
  createCompetitionWorkspace,
} from "./competition-workspaces.js";

test("M7 integration: pre-upgrade backup captures committed WAL rows, results and logo blobs before schema changes", () => {
  const root = mkdtempSync(join(tmpdir(), "uniquiz-m7-migration-"));
  const path = join(root, "official.sqlite3");
  const original = openDatabase(path);
  try {
    original.exec(`
      INSERT INTO colleges(name,sort_order) VALUES('كلية الآداب',1);
      INSERT INTO participants(college_id) VALUES(1);
      INSERT INTO categories(category_key,name,sort_order) VALUES('arts','فنون',1);
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
      VALUES(1,'سؤال سابق','A','B','C','D','A');
      INSERT INTO qualification_rounds(round_order,college_a_id,status)
      VALUES(1,1,'COMPLETED');
      INSERT INTO qualification_round_question_sets(round_id,locked_at)
      VALUES(1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
      VALUES(1,1,1,1);
      INSERT INTO live_submissions(
        round_id,question_position,station,question_id,selected_option,
        submitted_at_epoch_ms,response_time_ms,is_correct,score_micros
      ) VALUES(1,1,'A',1,'A',1234,456,1,25000000);
      UPDATE audience_settings SET event_title='مسابقة جامعة بابل';
      UPDATE app_meta SET value='13' WHERE key='schema_version';
    `);
    const logo = Buffer.from([0, 1, 5, 9, 255, 64]);
    original.prepare(
      "INSERT INTO audience_assets(slot,mime_type,bytes,updated_at) VALUES('university','image/png',?,CURRENT_TIMESTAMP)",
    ).run(logo);

    // Hold the original connection open so recent commits can still live in
    // WAL; copying only the base .sqlite3 file would be unsafe.
    const reopened = openDatabase(path);
    try {
      const fileNames = readdirSync(join(root, "migration-backups"));
      assert.equal(fileNames.length, 1);
      const saved = new Database(join(root, "migration-backups", fileNames[0]!), {
        readonly: true, fileMustExist: true,
      });
      try {
        assert.equal(
          (saved.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get() as {value:string}).value,
          "13",
        );
        assert.equal(
          (saved.prepare("SELECT score_micros AS score FROM live_submissions").get() as {score:number}).score,
          25_000_000,
        );
        assert.deepEqual((saved.prepare("SELECT bytes FROM audience_assets").get() as {bytes:Buffer}).bytes,logo);
        assert.equal(
          (saved.prepare("SELECT event_title AS title FROM audience_settings").get() as {title:string}).title,
          "مسابقة جامعة بابل",
        );
      } finally { saved.close(); }

      assert.equal(
        (reopened.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get() as {value:string}).value,
        "16",
      );
      assert.equal(
        (reopened.prepare("SELECT score_micros AS score FROM live_submissions").get() as {score:number}).score,
        25_000_000,
      );
      assert.deepEqual(reopened.pragma("foreign_key_check"),[]);
    } finally { reopened.close(); }

    const after = openDatabase(path);
    try {
      assert.equal(readdirSync(join(root, "migration-backups")).length,1);
      assert.equal(
        (after.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get() as {value:string}).value,
        "16",
      );
    } finally { after.close(); }
  } finally {
    original.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test("M7 integration: startup refuses schema migration when physical backup fails", () => {
  const root = mkdtempSync(join(tmpdir(),"uniquiz-m7-backup-blocked-"));
  const path = join(root, "official.sqlite3");
  try {
    const first = openDatabase(path);
    first.prepare("UPDATE app_meta SET value='13' WHERE key='schema_version'").run();
    first.close();
    // An occupied file where a backup directory is needed simulates a
    // filesystem failure regardless of the runner's root privileges.
    writeFileSync(join(root,"migration-backups"),"blocked");
    assert.throws(() => openDatabase(path));
    const check = new Database(path,{ readonly:true, fileMustExist:true });
    try {
      assert.equal(
        (check.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get() as {value:string}).value,
        "13",
      );
    } finally { check.close(); }
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("M7 integration: failed workspace restore rolls back participant rows, results and active selection", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO colleges(name,sort_order) VALUES('جامعة بابل',1);
      INSERT INTO participants(college_id) VALUES(1);
      INSERT INTO qualification_rounds(round_order,college_a_id,status)
      VALUES(1,1,'COMPLETED');
      UPDATE live_state SET phase='ROUND_COMPLETE',round_id=1;
      UPDATE audience_settings SET event_title='الأصل';
    `);
    const target = createCompetitionWorkspace(db,"تجربة","team");
    const record = db.prepare("SELECT payload_json AS payload FROM competition_workspaces WHERE id=?")
      .get(target.id) as {payload:string};
    const payload = JSON.parse(record.payload) as Record<string,Array<Record<string,unknown>>>;
    payload.participants.push({college_id:99999});
    db.prepare("UPDATE competition_workspaces SET payload_json=? WHERE id=?")
      .run(JSON.stringify(payload),target.id);

    assert.throws(() => activateCompetitionWorkspace(db,target.id));
    assert.equal(activeWorkspaceId(db),"legacy");
    assert.equal((db.prepare("SELECT name FROM colleges").get() as {name:string}).name,"جامعة بابل");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM participants").get() as {count:number}).count,1);
    assert.equal(
      (db.prepare("SELECT event_title AS title FROM audience_settings").get() as {title:string}).title,
      "الأصل",
    );
    assert.equal((db.prepare("SELECT phase FROM live_state").get() as {phase:string}).phase,"ROUND_COMPLETE");
    assert.deepEqual(db.pragma("foreign_key_check"),[]);
  } finally { db.close(); }
});

test("M7 integration: a deliberate DDL collision rolls back the entire schema migration", () => {
  const root = mkdtempSync(join(tmpdir(), "uniquiz-m7-ddl-rollback-"));
  const path = join(root, "official.sqlite3");
  try {
    const prepared = openDatabase(path);
    prepared.exec(`
      INSERT INTO colleges(name,sort_order) VALUES('Archive Participant',1);
      INSERT INTO audit_events(event_type,occurred_at)
        VALUES('LEGACY_RESULT',CURRENT_TIMESTAMP);
    `);
    // Re-create one legacy 1..10 table as it existed before M7, and place
    // a table with the migration's temporary name to force a DDL failure.
    prepared.pragma("foreign_keys = OFF");
    const row = prepared.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='qualification_round_questions'",
    ).get() as {sql:string};
    prepared.exec("DROP TABLE qualification_round_questions");
    prepared.exec(row.sql.replace(
      /CHECK\s*\(\s*position\s*>=\s*1\s*\)/,
      "CHECK (position BETWEEN 1 AND 10)",
    ));
    prepared.exec("CREATE TABLE qualification_round_questions_m7(blocker INTEGER)");
    prepared.prepare("UPDATE app_meta SET value='10' WHERE key='schema_version'").run();
    prepared.pragma("foreign_keys = ON");
    prepared.close();

    assert.throws(
      () => openDatabase(path),
      /already exists|M7_POSITION_MIGRATION/,
    );

    const original = new Database(path, { readonly:true, fileMustExist:true });
    try {
      assert.equal(
        (original.prepare("SELECT value FROM app_meta WHERE key='schema_version'")
          .get() as {value:string}).value,
        "10",
      );
      const table = original.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='qualification_round_questions'",
      ).get() as {sql:string};
      assert.match(table.sql, /BETWEEN 1 AND 10/);
      assert.equal(
        (original.prepare("SELECT event_type AS name FROM audit_events")
          .get() as {name:string}).name,
        "LEGACY_RESULT",
      );
      assert.equal(
        (original.prepare("SELECT COUNT(*) AS count FROM colleges")
          .get() as {count:number}).count,
        1,
      );
    } finally { original.close(); }
    assert.equal(readdirSync(join(root,"migration-backups")).length,1);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
