import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { parseImportBuffer } from "./importer.js";

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

test("CSV import rejects difficulty column", async () => {
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
    "sports,Question 1,A1,B1,C1,D1,A,easy",
  ].join("\n");

  const parsed = await parseImportBuffer(
    db as never,
    "questions.csv",
    Buffer.from(csv),
  );

  assert.match(
    parsed.issues
      .filter((entry) => entry.level === "error")
      .map((entry) => entry.message)
      .join(" "),
    /difficulty/,
  );

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
