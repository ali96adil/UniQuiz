/**
 * M7 / Mode 01 is a single ranked points duel, not a mode switcher.
 * Kept outside persistence: legacy 2026 data inherits this mode semantically
 * without a DB migration or any historical score rewrite.
 *
 * Participant kind (college, department, class, team) and scoring formula
 * (fixed/time-decay) are SETTINGS within the same ranked duel mode.
 */
export const RANKED_DUEL_MODE = Object.freeze({
  id: "ranked_duel",
  number: 1,
  labelAr: "المواجهة بالنقاط",
  labelEn: "Ranked Duel",
  descriptionAr: "فريق A ضد فريق B يجيبان عن الأسئلة نفسها؛ تُجمع النقاط وزمن الإجابات عبر الجولات لتحديد الترتيب العام دون إقصاء.",
} as const);
