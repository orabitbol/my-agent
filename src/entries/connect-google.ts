// Connects a Google account to the agent. Run it once per account:
//   npm run connect-google

import { execFile } from "node:child_process";
import { connectAccount, listAccounts } from "../core/google/auth.js";

console.log("Opening Google in your browser. Choose the account to connect and approve.\n");

const email = await connectAccount((url) => {
  execFile("open", [url], (error) => {
    // If the browser did not open, the user can paste the address manually.
    if (error) console.log(`Open this address in your browser:\n${url}\n`);
  });
});

console.log(`Connected: ${email}`);
console.log(`All connected accounts: ${(await listAccounts()).join(", ")}`);
process.exit(0);
