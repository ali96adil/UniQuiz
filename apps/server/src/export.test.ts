import assert from "node:assert/strict";
import test from "node:test";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import ExcelJS from "exceljs";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { registerImportRoutes } from "./importer.js";

test("Excel export contains current master data and blank source_ref", async () => {
  const db = openDatabase(":memory:");

  db.exec(`
    INSERT INTO colleges (name, short_name, sort_order)
    VALUES
      ('College A', 'A', 1),
      ('College B', NULL, 2);

    INSERT INTO participants (college_id)
    VALUES (1);

    INSERT INTO categories (category_key, name, sort_order)
    VALUES
      ('sports', 'Sports', 1),
      ('history', 'History', 2),
      ('science', 'Science', 3),
      ('arts', 'Arts', 4),
      ('general', 'General', 5);

    INSERT INTO questions (
      category_id,
      prompt,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_option,
      source_ref
    )
    VALUES (
      1,
      'Export question',
      'A1',
      'B1',
      'C1',
      'D1',
      'C',
      NULL
    );
  `);

  const app = Fastify();
  await app.register(multipart);
  const io = new SocketIOServer(app.server);
  registerImportRoutes(app, db, io);
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/api/export/data.xlsx",
  });

  assert.equal(response.statusCode, 200);
  assert.match(
    response.headers["content-type"] ?? "",
    /spreadsheetml/,
  );

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.rawPayload as any);

  const colleges = workbook.getWorksheet("Colleges");
  const categories = workbook.getWorksheet("Categories");
  const questions = workbook.getWorksheet("Questions");

  assert.ok(colleges);
  assert.ok(categories);
  assert.ok(questions);

  assert.equal(colleges.getRow(2).getCell(1).text, "College A");
  assert.equal(colleges.getRow(2).getCell(3).text, "yes");
  assert.equal(colleges.getRow(3).getCell(3).text, "no");

  assert.equal(categories.rowCount, 6);

  assert.equal(questions.getRow(2).getCell(1).text, "sports");
  assert.equal(questions.getRow(2).getCell(2).text, "Export question");
  assert.equal(questions.getRow(2).getCell(7).text, "C");
  assert.equal(questions.getRow(2).getCell(8).text, "");

  io.close();
  await app.close();
  db.close();
});
