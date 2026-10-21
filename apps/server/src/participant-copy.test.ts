import assert from "node:assert/strict";
import test from "node:test";
import { participantAwareAudienceText } from "@uniquiz/shared";
test("default audience waiting/count labels follow workspace participant type", () => {
  for (const [kind,waiting,count] of [
    ["department","بانتظار تثبيت الأقسام المشاركة","{count} قسم مشارك"],
    ["class","بانتظار تثبيت الشعب المشاركة","{count} شعبة مشاركة"],
    ["team","بانتظار تثبيت الفرق المشاركة","{count} فريق مشارك"],
  ] as const) {
    assert.equal(participantAwareAudienceText("بانتظار تثبيت الكليات المشاركة",kind),waiting);
    assert.equal(participantAwareAudienceText("{count} كلية مشاركة",kind),count);
  }
  assert.equal(participantAwareAudienceText("{count} كلية مشاركة","college"),"{count} كلية مشاركة");
});
test("custom copy remains unmodified", () => {
  assert.equal(participantAwareAudienceText("النص المخصص", "department"),"النص المخصص");
});
