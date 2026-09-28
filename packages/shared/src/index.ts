export const CLIENT_ROLES = [
  "operator",
  "display",
  "team-a",
  "team-b",
  "unknown",
] as const;

export type ClientRole = (typeof CLIENT_ROLES)[number];

export const AUDIENCE_STATES = [
  "WELCOME",
  "DRAW_INTRO",
  "DRAW_ACTIVE",
  "DRAW_COMPLETE",
  "ROUND_INTRO",
  "QUESTION_READY",
  "QUESTION_COUNTDOWN",
  "QUESTION_ACTIVE",
  "QUESTION_CLOSED",
  "QUESTION_REVEAL",
  "BETWEEN_QUESTIONS",
  "ROUND_COMPLETE",
  "NEXT_ROUND",
  "INTERMISSION",
  "FINAL_RESULTS",
] as const;

export type AudienceState = (typeof AUDIENCE_STATES)[number];

export interface StationPresence {
  role: ClientRole;
  connected: boolean;
  connections: number;
}

export interface PresenceSnapshot {
  generatedAt: string;
  stations: StationPresence[];
}
