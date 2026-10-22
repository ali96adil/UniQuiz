import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "./database.js";
import { registerCompetitionArchiveRoutes } from "./competition-archives.js";
import { getQuestionBankSummary } from "./importer.js";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("M7 public category labels and immutable archive survive later edits", async () => {
  const db = openDatabase(":memory:");
  const app = Fastify();
  try {
    db.exec(`
      INSERT INTO colleges (name, sort_order) VALUES ('كلية التربية', 1);
      INSERT INTO participants (college_id) VALUES (1);
      INSERT INTO qualification_rounds (
        round_order, college_a_id, college_b_id, status
      ) VALUES (1, 1, NULL, 'COMPLETED');
      INSERT INTO categories (category_key, name, display_name, sort_order)
      VALUES ('sports_specialist', 'رياضة تخصصية', 'رياضة', 1);
      INSERT INTO questions (
        category_id, prompt, option_a, option_b, option_c,
        option_d, correct_option
      ) VALUES (1, 'سؤال من بطولة سابقة', 'أ', 'ب', 'ج', 'د', 'A');
      INSERT INTO qualification_round_question_sets (round_id, locked_at)
      VALUES (1, CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions (
        round_id, position, question_id, category_id
      ) VALUES (1, 1, 1, 1);
    `);

    const summary = getQuestionBankSummary(db);
    assert.equal(summary.categories[0].name, "رياضة");
    assert.equal(summary.categories[0].internalName, "رياضة تخصصية");

    registerCompetitionArchiveRoutes(app, db);
    await app.ready();

    const result = await app.inject({
      method: "POST",
      url: "/api/archives",
      payload: { title: "بنك المعلومات 2026" },
    });
    assert.equal(result.statusCode, 201, result.body);
    const created = result.json() as { archive: { id: string } };

    db.prepare("UPDATE questions SET prompt = ? WHERE id = 1")
      .run("سؤال تم تعديله بالمكتبة");
    db.prepare("UPDATE categories SET display_name = ? WHERE id = 1")
      .run("المعلومات الرياضية");

    const detail = await app.inject({
      method: "GET",
      url: "/api/archives/" + created.archive.id,
    });
    assert.equal(detail.statusCode, 200, detail.body);
    const archiveDetail = detail.json() as {
      snapshot: { questionBank: { categories: Array<{ name: string }> } };
    };
    assert.equal(archiveDetail.snapshot.questionBank.categories[0].name, "رياضة");

    const exportResponse = await app.inject({
      method: "GET",
      url: "/api/archives/" + created.archive.id + "/export",
    });
    assert.equal(exportResponse.statusCode, 200);
    const payload = exportResponse.json() as {
      tables: { questions: Array<{ prompt: string }> };
    };
    assert.equal(payload.tables.questions[0].prompt, "سؤال من بطولة سابقة");

    const listing = await app.inject({ method: "GET", url: "/api/archives" });
    assert.equal((listing.json() as { archives: unknown[] }).archives.length, 1);
  } finally {
    await app.close();
    db.close();
  }
});

test("M7 archive title edit preserves original ranking and questions; deletion needs exact title and verified backup", async () => {
  const root = mkdtempSync(join(tmpdir(),"uniquiz-m7-delete-archive-"));
  const path = join(root,"archives.db");
  const db = openDatabase(path);
  const app = Fastify();
  try {
    db.exec(`
      INSERT INTO colleges(name,sort_order) VALUES ('Team A',1);
      INSERT INTO participants(college_id) VALUES (1);
      INSERT INTO qualification_rounds(round_order,college_a_id,status)
      VALUES (1,1,'COMPLETED');
      INSERT INTO categories(category_key,name,sort_order) VALUES('sport','Sports',1);
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
      VALUES (1,'Historical prompt?','A','B','C','D','A');
      INSERT INTO qualification_round_question_sets(round_id,locked_at)
      VALUES (1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions(round_id,position,question_id,category_id)
      VALUES (1,1,1,1);
    `);
    registerCompetitionArchiveRoutes(app,db,path);
    await app.ready();
    const original=await app.inject({method:"POST",url:"/api/archives",payload:{title:"2026 Official"}});
    assert.equal(original.statusCode,201,original.body);
    const id=original.json().archive.id as string;
    const originalExport=(await app.inject({method:"GET",url:"/api/archives/"+id+"/export"})).json();
    const denied=await app.inject({method:"DELETE",url:"/api/archives/"+id,
      payload:{confirm:"DELETE_ARCHIVE",title:"not the exact name"}});
    assert.equal(denied.statusCode,409);
    assert.equal((await app.inject({method:"DELETE",url:"/api/archives/"+id,
      payload:{confirm:"NO",title:"2026 Official"}})).statusCode,400);
    assert.equal(readdirSync(root).includes("backups"),false);
    const rename=await app.inject({method:"PATCH",url:"/api/archives/"+id,
      payload:{title:"2026 Official Final Results"}});
    assert.equal(rename.statusCode,200,rename.body);
    const updated=(await app.inject({method:"GET",url:"/api/archives/"+id+"/export"})).json();
    assert.equal(updated.title,"2026 Official Final Results");
    assert.deepEqual(updated.snapshot,originalExport.snapshot,"Title-only edit cannot alter historical scores");
    assert.deepEqual(updated.tables,originalExport.tables,"Title-only edit cannot alter question history");
    const incorrectOld=await app.inject({method:"DELETE",url:"/api/archives/"+id,
      payload:{confirm:"DELETE_ARCHIVE",title:"2026 Official"}});
    assert.equal(incorrectOld.statusCode,409);
    const remove=await app.inject({method:"DELETE",url:"/api/archives/"+id,
      payload:{confirm:"DELETE_ARCHIVE",title:"2026 Official Final Results"}});
    assert.equal(remove.statusCode,200,remove.body);
    assert.equal((await app.inject({method:"GET",url:"/api/archives/"+id})).statusCode,404);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM questions").get() as {n:number}).n,1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM competition_workspaces").get() as {n:number}).n,1);
    const files=readdirSync(join(root,"backups"));
    assert.equal(files.filter(x=>x.includes("pre-reset") && x.endsWith(".db")).length,1);
  } finally { await app.close();db.close();rmSync(root,{recursive:true,force:true}); }
});
