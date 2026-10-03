import { resolve } from "node:path";
import { config } from "./config.js";
import {
  createDatabaseBackup,
  isLocalServerRunning,
  listDatabaseBackups,
  restoreDatabaseFromBackup,
} from "./operations.js";
import { openDatabase } from "./database.js";

async function main() {
  const [command, argument] = process.argv.slice(2);

  if (command === "backup") {
    const db = openDatabase(config.databasePath);
    try {
      const backup = createDatabaseBackup(
        db,
        config.databasePath,
      );
      console.log(JSON.stringify(backup, null, 2));
    } finally {
      db.close();
    }
    return;
  }

  if (command === "list") {
    console.log(
      JSON.stringify(
        listDatabaseBackups(config.databasePath),
        null,
        2,
      ),
    );
    return;
  }

  if (command === "restore") {
    if (!argument) {
      throw new Error(
        "Usage: pnpm ops:restore -- /path/to/backup.db",
      );
    }

    if (await isLocalServerRunning(config.port)) {
      throw new Error(
        "REFUSING_RESTORE_WHILE_UNIQUIZ_SERVER_IS_RUNNING",
      );
    }

    const result = restoreDatabaseFromBackup(
      resolve(argument),
      config.databasePath,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(
    "Usage: backup-cli.ts <backup|list|restore> [backup.db]",
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
