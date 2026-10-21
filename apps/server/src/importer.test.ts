import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { parseImportBuffer, registerImportRoutes } from "./importer.js";
import { openDatabase } from "./database.js";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { Server as SocketIOServer } from "socket.io";

function testDatabase() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL UNIQUE
    );
  `);
  return db;
}

test("CSV question import accepts four options and correct answer", async () => {
  const db = testDatabase();
  db.exec(`
    INSERT INTO categories (category_key, name, sort_order) VALUES
    ('sports', 'Sports', 1),
    ('history', 'History', 2),
    ('science', 'Science', 3),
    ('arts', 'Arts', 4),
    ('general', 'General', 5);
  `);

  const csv = [
    "category_key,question,option_a,option_b,option_c,option_d,correct_option,source_ref",
    "sports,Question 1,A1,B1,C1,D1,B,Q1",
  ].join("\n");

  const parsed = await parseImportBuffer(
    db as never,
    "questions.csv",
    Buffer.from(csv),
  );

  assert.equal(parsed.questions?.length, 1);
  assert.equal(parsed.questions?.[0]?.correctOption, "B");
  assert.equal(
    parsed.issues.filter((entry) => entry.level === "error").length,
    0,
  );

  db.close();
});

test("CSV import accepts difficulty from 1 to 5", async () => {
  const db = testDatabase();
  db.exec(`
    INSERT INTO categories (category_key, name, sort_order) VALUES
    ('sports', 'Sports', 1),
    ('history', 'History', 2),
    ('science', 'Science', 3),
    ('arts', 'Arts', 4),
    ('general', 'General', 5);
  `);

  const csv = [
    "category_key,question,option_a,option_b,option_c,option_d,correct_option,difficulty",
    "sports,Question 1,A1,B1,C1,D1,A,1",
  ].join("\n");

  const parsed = await parseImportBuffer(
    db as never,
    "questions.csv",
    Buffer.from(csv),
  );

  assert.equal(parsed.questions?.[0]?.difficulty, 1);
  assert.equal(parsed.issues.filter((entry) => entry.level === "error").length, 0);

  db.close();
});

test("XLSX workbook reads Colleges, Categories and Questions sheets", async () => {
  const db = testDatabase();
  const workbook = new ExcelJS.Workbook();

  const colleges = workbook.addWorksheet("Colleges");
  colleges.addRow(["name", "short_name", "participating"]);
  colleges.addRow(["College A", "A", "yes"]);
  colleges.addRow(["College B", "B", "no"]);

  const categories = workbook.addWorksheet("Categories");
  categories.addRow(["key", "name"]);
  for (const [key, name] of [
    ["sports", "Sports"],
    ["history", "History"],
    ["science", "Science"],
    ["arts", "Arts"],
    ["general", "General"],
  ]) {
    categories.addRow([key, name]);
  }

  const questions = workbook.addWorksheet("Questions");
  questions.addRow([
    "category_key",
    "question",
    "option_a",
    "option_b",
    "option_c",
    "option_d",
    "correct_option",
    "source_ref",
  ]);
  questions.addRow([
    "sports",
    "Question 1",
    "A1",
    "B1",
    "C1",
    "D1",
    "C",
    "S-001",
  ]);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseImportBuffer(db as never, "data.xlsx", buffer);

  assert.equal(parsed.colleges?.length, 2);
  assert.equal(parsed.colleges?.[0]?.participating, true);
  assert.equal(parsed.categories?.length, 5);
  assert.equal(parsed.questions?.length, 1);
  assert.equal(parsed.questions?.[0]?.correctOption, "C");
  assert.equal(
    parsed.issues.filter((entry) => entry.level === "error").length,
    0,
  );

  db.close();
});


test("source_ref may stay blank without validation errors", async () => {
  const db = testDatabase();
  db.exec(`
    INSERT INTO categories (category_key, name, sort_order) VALUES
    ('sports', 'Sports', 1),
    ('history', 'History', 2),
    ('science', 'Science', 3),
    ('arts', 'Arts', 4),
    ('general', 'General', 5);
  `);

  const csv = [
    "category_key,question,option_a,option_b,option_c,option_d,correct_option,source_ref",
    "sports,Question without source,A1,B1,C1,D1,A,",
    "history,Another question,A2,B2,C2,D2,D,",
  ].join("\n");

  const parsed = await parseImportBuffer(
    db as never,
    "questions.csv",
    Buffer.from(csv),
  );

  assert.equal(parsed.questions?.length, 2);
  assert.equal(parsed.questions?.[0]?.sourceRef, null);
  assert.equal(parsed.questions?.[1]?.sourceRef, null);
  assert.equal(
    parsed.issues.filter((entry) => entry.level === "error").length,
    0,
  );

  db.close();
});


test("CSV question import accepts visible category names and canonicalizes them", async () => {
  const db = testDatabase();
  db.exec(`
    INSERT INTO categories (category_key, name, sort_order) VALUES
    ('sport_internal', 'رياضي', 1),
    ('history_internal', 'تاريخ', 2),
    ('geo_internal', 'جغرافيا', 3),
    ('art_internal', 'فني', 4),
    ('culture_internal', 'ثقافي', 5);
  `);

  const csv = [
    "category_key,question,option_a,option_b,option_c,option_d,correct_option,source_ref",
    "تاريخ,Visible-name question,A1,B1,C1,D1,C,",
  ].join("\n");

  const parsed = await parseImportBuffer(
    db as never,
    "questions.csv",
    Buffer.from(csv),
  );

  assert.equal(parsed.questions?.length, 1);
  assert.equal(
    parsed.questions?.[0]?.categoryKey,
    "history_internal",
  );
  assert.equal(
    parsed.issues.filter((entry) => entry.level === "error").length,
    0,
  );

  db.close();
});


test("CSV import rejects out-of-range difficulty and preserves default for old files", async () => {
  const db = testDatabase();
  db.exec("INSERT INTO categories (category_key, name, sort_order) VALUES ('sports','Sports',1)");
  const header = "category_key,question,option_a,option_b,option_c,option_d,correct_option,difficulty";
  const bad = await parseImportBuffer(db as never, "questions.csv", Buffer.from(
    [header, "sports,Q1,A1,B1,C1,D1,A,6"].join("\n")));
  assert.ok(bad.issues.some((entry) => entry.level === "error" && entry.message.includes("difficulty")));
  const old = await parseImportBuffer(db as never, "questions.csv", Buffer.from(
    ["category_key,question,option_a,option_b,option_c,option_d,correct_option",
     "sports,Q2,A1,B1,C1,D1,A"].join("\n")));
  assert.equal(old.questions?.[0]?.difficulty, 3);
  db.close();
});

// Existing master questions must not be duplicated by repeated spreadsheet
// uploads, and stale previews must not overwrite newer manual edits.
test("import preview reports duplicate prompt and source_ref already in question bank", async () => {
  const db=openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO categories(category_key,name,sort_order) VALUES('sports','Sport',1);
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option,source_ref)
      VALUES(1,'Existing question','A','B','C','D','A','Q-001');
    `);
    const csv=[
      "category_key,question,option_a,option_b,option_c,option_d,correct_option,source_ref,difficulty",
      "sports,Existing question,E,F,G,H,A,Q-002,2",
      "sports,Different question,I,J,K,L,B,Q-001,4",
    ].join("\n");
    const preview=await parseImportBuffer(db,"questions.csv",Buffer.from(csv));
    const errors=preview.issues.filter((item)=>item.level==="error").map(x=>x.message);
    assert.ok(errors.some(x=>x.includes("already exists")),errors.join(" | "));
    assert.ok(errors.some(x=>x.includes("source_ref is already used")),errors.join(" | "));
  } finally { db.close(); }
});

test("a stale validated CSV preview cannot partially import duplicate questions", async () => {
  const db=openDatabase(":memory:");
  const app=Fastify();
  await app.register(multipart);
  const io=new SocketIOServer(app.server);
  try {
    db.exec("INSERT INTO categories(category_key,name,sort_order) VALUES('sports','Sport',1)");
    registerImportRoutes(app,db,io);
    await app.ready();
    const csv=[
      "category_key,question,option_a,option_b,option_c,option_d,correct_option,source_ref,difficulty",
      "sports,Future question,A,B,C,D,A,Q-200,1",
      "sports,Brand new question,E,F,G,H,B,Q-201,5",
    ].join("\n");
    const boundary="uniquiz-m7-preview-test-boundary";
    const payload=Buffer.from([
      "--"+boundary,
      'Content-Disposition: form-data; name="file"; filename="questions.csv"',
      "Content-Type: text/csv",
      "",
      csv,
      "--"+boundary+"--",
      "",
    ].join("\r\n"));
    const preview=await app.inject({
      method:"POST",url:"/api/import/preview",
      headers:{"content-type":"multipart/form-data; boundary="+boundary},
      payload,
    });
    assert.equal(preview.statusCode,200,preview.body);
    const info=preview.json() as {previewId:string;valid:boolean};
    assert.equal(info.valid,true,preview.body);
    // A separate operator saves a conflicting question after the preview.
    db.prepare(`INSERT INTO questions
      (category_id,prompt,option_a,option_b,option_c,option_d,correct_option,source_ref)
      VALUES (1,'Future question','A','B','C','D','A','Q-200')`).run();
    const apply=await app.inject({method:"POST",url:"/api/import/apply",
      payload:{previewId:info.previewId,questionMode:"append"}});
    assert.equal(apply.statusCode,409,apply.body);
    assert.equal(apply.json().error,"QUESTION_IMPORT_CONFLICT");
    const after=db.prepare("SELECT prompt FROM questions ORDER BY id").all() as Array<{prompt:string}>;
    assert.deepEqual(after.map(x=>x.prompt),["Future question"]);
  } finally {io.close();await app.close();db.close();}
});
