import { readFileSync, writeFileSync } from "node:fs";

const phase = process.argv[2];
const base = "http://127.0.0.1:8787";
const snapshotPath = "/tmp/uniquiz-draw-before.json";

async function request(path, method = "GET", body) {
  const response = await fetch(base + path, {
    method,
    headers: body
      ? { "content-type": "application/json" }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      `${method} ${path}: ${response.status} ${JSON.stringify(payload)}`,
    );
  }

  return payload;
}

if (phase === "create") {
  const setup = await request("/api/setup/colleges", "PUT", {
    colleges: [
      { name: "College 1" },
      { name: "College 2" },
      { name: "College 3" },
      { name: "College 4" },
      { name: "College 5" },
    ],
  });

  const collegeIds = setup.colleges.map((college) => college.id);

  await request("/api/setup/participants", "PUT", { collegeIds });
  await request("/api/setup/participants/lock", "POST", {});
  const draw = await request("/api/draw", "POST", {});

  if (draw.rounds.length !== 3) {
    throw new Error("Expected exactly three rounds for five colleges");
  }

  if (draw.rounds.at(-1)?.collegeB !== null) {
    throw new Error("Expected solo round to be last");
  }

  const appearances = draw.rounds.flatMap((round) => [
    round.collegeA.id,
    ...(round.collegeB ? [round.collegeB.id] : []),
  ]);

  if (
    appearances.length !== 5 ||
    new Set(appearances).size !== 5
  ) {
    throw new Error("Every participant must appear exactly once");
  }

  writeFileSync(snapshotPath, JSON.stringify(draw.rounds));
  console.log("M2 draw created and validated");
} else if (phase === "verify") {
  const after = await request("/api/draw");
  const before = JSON.parse(readFileSync(snapshotPath, "utf8"));

  if (JSON.stringify(after.rounds) !== JSON.stringify(before)) {
    throw new Error("Official draw changed after server restart");
  }

  console.log("M2 draw persistence verified after restart");
} else {
  throw new Error("Usage: node m2-persistence-smoke.mjs <create|verify>");
}
