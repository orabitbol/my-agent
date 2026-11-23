// Loads .env from the project root. The desktop app imports this file first,
// so the settings exist before any other code reads them.

import { fileURLToPath } from "node:url";

process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
