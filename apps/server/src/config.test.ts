import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "./config.js";

test("official and rehearsal modes use isolated default databases", () => {
  const official = resolveConfig({
    UNIQUIZ_MODE: "official",
  });
  const rehearsal = resolveConfig({
    UNIQUIZ_MODE: "rehearsal",
  });

  assert.equal(official.mode, "official");
  assert.equal(rehearsal.mode, "rehearsal");
  assert.match(official.databasePath, /uniquiz\.db$/);
  assert.match(
    rehearsal.databasePath,
    /uniquiz-rehearsal\.db$/,
  );
  assert.notEqual(
    official.databasePath,
    rehearsal.databasePath,
  );
});

test("explicit database path still overrides the mode default", () => {
  const rehearsal = resolveConfig({
    UNIQUIZ_MODE: "rehearsal",
    UNIQUIZ_DB_PATH: "/tmp/custom-rehearsal.db",
  });

  assert.equal(
    rehearsal.databasePath,
    "/tmp/custom-rehearsal.db",
  );
});
