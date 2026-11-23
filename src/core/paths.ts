// Where the agent keeps its files. Everything is resolved from the project
// root, so it does not matter which folder the app was started from.
// MY_AGENT_HOME overrides the root (the tests use it to work in a temp folder).

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.MY_AGENT_HOME
  ? pathToFileURL(resolve(process.env.MY_AGENT_HOME) + "/")
  : new URL("../../", import.meta.url);

/** Keys and sign-in tokens. Never committed to git. */
export const SECRETS_DIR = new URL("secrets/", ROOT);
/** Logs and, later, the memory database. Never committed to git. */
export const DATA_DIR = new URL("data/", ROOT);
