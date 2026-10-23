import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { openDatabase } from "./database.js";
import { registerQuestionEditorRoutes } from "./question-editor.js";
import { createCompetitionWorkspace, activateCompetitionWorkspace } from "./competition-workspaces.js";
import { saveCompetitionArchive } from "./competition-archives.js";
test("manual category/question create-edit-soft-delete and history protection", async () => {
  const db=openDatabase(":memory:");
  const app=Fastify();
  const io=new SocketIOServer(app.server);
  registerQuestionEditorRoutes(app,db,io);
  await app.ready();
  const cat=await app.inject({method:"POST",url:"/api/question-bank/categories",payload:{key:"sport_specialist",name:"رياضة تخصصية",displayName:"رياضة"}});
  assert.equal(cat.statusCode,201,cat.body);
  const q={categoryKey:"sport_specialist",prompt:"من فاز بالمنافسة سنة 2010؟",optionA:"فريق أول",optionB:"فريق ثاني",optionC:"فريق ثالث",optionD:"فريق رابع",correctOption:"A",difficulty:1};
  const created=await app.inject({method:"POST",url:"/api/question-bank/items",payload:q});
  assert.equal(created.statusCode,201,created.body);
  const id=(created.json() as {id:number}).id;
  const rows=await app.inject({method:"GET",url:"/api/question-bank/items?difficulty=1"});
  assert.equal(rows.statusCode,200);
  assert.equal((rows.json() as {total:number}).total,1);
  const changed=await app.inject({method:"PUT",url:"/api/question-bank/items/"+id,payload:{...q,difficulty:5}});
  assert.equal(changed.statusCode,200);
  const duplicate=await app.inject({method:"POST",url:"/api/question-bank/items",payload:q});
  assert.equal(duplicate.statusCode,409);
  const inactive=await app.inject({method:"DELETE",url:"/api/question-bank/items/"+id});
  assert.equal(inactive.statusCode,200);
  const all=await app.inject({method:"GET",url:"/api/question-bank/items?status=inactive"});
  assert.equal((all.json() as {total:number}).total,1);
  const old=await app.inject({method:"POST",url:"/api/question-bank/items",payload:{...q,prompt:"سؤال محفوظ في التاريخ"}});
  assert.equal(old.statusCode,201);
  const oldId=(old.json() as {id:number}).id;
  db.exec("INSERT INTO colleges (name,sort_order) VALUES ('A',1),('B',2)");
  db.exec("INSERT INTO qualification_rounds (round_order,college_a_id,college_b_id) VALUES (1,1,2)");
  db.prepare("INSERT INTO qualification_round_question_sets (round_id,locked_at) VALUES (1,'now')").run();
  db.prepare("INSERT INTO qualification_round_questions (round_id,position,question_id,category_id) VALUES (1,1,?,1)").run(oldId);
  const protectedEdit=await app.inject({method:"PUT",url:"/api/question-bank/items/"+oldId,payload:{...q,prompt:"تغيير الخطأ"}});
  assert.equal(protectedEdit.statusCode,409);
  // The source event's rows now live in an inactive workspace JSON snapshot.
  // They must remain protected even when the active event has no allocations.
  const next = createCompetitionWorkspace(db, "New event", "team");
  activateCompetitionWorkspace(db, next.id);
  const historicalEdit = await app.inject({method:"PUT",url:"/api/question-bank/items/"+oldId,
    payload:{...q,prompt:"Overwrite stored old tournament question"}});
  assert.equal(historicalEdit.statusCode,409,historicalEdit.body);
  await app.close();io.close();db.close();
});

test("M7.7 archived question remains immutable after live allocations are removed", async () => {
  const db=openDatabase(":memory:");
  const app=Fastify();
  const io=new SocketIOServer(app.server);
  try {
    registerQuestionEditorRoutes(app,db,io); await app.ready();
    db.exec(`
      INSERT INTO categories(category_key,name,sort_order) VALUES ('sports','Sport',1);
      INSERT INTO questions(category_id,prompt,option_a,option_b,option_c,option_d,correct_option)
      VALUES (1,'Archived question','A','B','C','D','A');
      INSERT INTO colleges(name,sort_order) VALUES('College A',1);
      INSERT INTO qualification_rounds(round_order,college_a_id,status) VALUES(1,1,'PENDING');
      INSERT INTO qualification_round_question_sets(round_id,locked_at) VALUES(1,CURRENT_TIMESTAMP);
      INSERT INTO qualification_round_questions(round_id,position,question_id,category_id) VALUES (1,1,1,1);
    `);
    const saved=saveCompetitionArchive(db,"Historical sports quiz");
    assert.ok(saved);
    db.prepare("DELETE FROM qualification_round_question_sets").run(); // cascades allocations
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM qualification_round_questions").get() as {n:number}).n,0);
    const response=await app.inject({method:"PUT",url:"/api/question-bank/items/1",payload:{
      categoryKey:"sports",prompt:"Change historical answer",optionA:"A",optionB:"B",optionC:"C",optionD:"D",
      correctOption:"B",difficulty:5,
    }});
    assert.equal(response.statusCode,409,response.body);
    assert.equal(response.json().error,"QUESTION_HISTORICALLY_USED");
    assert.equal((db.prepare("SELECT correct_option AS answer FROM questions WHERE id=1").get() as {answer:string}).answer,"A");
  } finally { await app.close(); io.close(); db.close(); }
});
