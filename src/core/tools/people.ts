// Tool: find a person's email address by name, so events can invite them.
// Looks in three places per account: the organization's directory, the user's
// saved contacts, and people the user has exchanged mail with.

import type { Tool } from "./types.js";
import { SCOPE, listAccounts } from "../google/auth.js";
import { googleFetch, hasScope } from "../google/api.js";

const PEOPLE = "https://people.googleapis.com/v1";

type Person = { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[] };
type Match = { name: string; email: string; account: string; source: "directory" | "contacts" | "mail history" };

function toMatches(people: Person[], account: string, source: Match["source"]): Match[] {
  return people.flatMap((person) => {
    const email = person.emailAddresses?.[0]?.value?.toLowerCase();
    return email ? [{ name: person.names?.[0]?.displayName ?? email, email, account, source }] : [];
  });
}

async function searchAccount(account: string, query: string): Promise<Match[]> {
  const q = encodeURIComponent(query);
  const mask = "readMask=names,emailAddresses";

  // Each source is tried only if the account granted it. A source that fails
  // (for example: a personal account has no directory) does not stop the others.
  const [canDirectory, canContacts, canOther] = await Promise.all([
    hasScope(account, SCOPE.directory),
    hasScope(account, SCOPE.contacts),
    hasScope(account, SCOPE.otherContacts),
  ]);
  const searches: Promise<Match[]>[] = [];
  if (canDirectory) {
    searches.push(
      googleFetch<{ people?: Person[] }>(
        account, [SCOPE.directory],
        `${PEOPLE}/people:searchDirectoryPeople?query=${q}&${mask}&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE&pageSize=10`,
      ).then((body) => toMatches(body.people ?? [], account, "directory")),
    );
  }
  if (canContacts) {
    searches.push(
      googleFetch<{ results?: { person?: Person }[] }>(
        account, [SCOPE.contacts], `${PEOPLE}/people:searchContacts?query=${q}&${mask}&pageSize=10`,
      ).then((body) => toMatches((body.results ?? []).map((r) => r.person ?? {}), account, "contacts")),
    );
  }
  if (canOther) {
    searches.push(
      googleFetch<{ results?: { person?: Person }[] }>(
        account, [SCOPE.otherContacts], `${PEOPLE}/otherContacts:search?query=${q}&${mask}&pageSize=10`,
      ).then((body) => toMatches((body.results ?? []).map((r) => r.person ?? {}), account, "mail history")),
    );
  }
  if (searches.length === 0) {
    throw new Error(`The account ${account} has not granted permission to look people up. Ask the user to connect it again from the app.`);
  }

  const results = await Promise.allSettled(searches);
  if (results.every((result) => result.status === "rejected")) {
    throw new Error(String((results[0] as PromiseRejectedResult).reason.message));
  }
  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

export const findPeople: Tool = {
  name: "find_people",
  description:
    "Finds people by name or by part of an email address, in the organization's directory and the user's " +
    "contacts, in all connected accounts. Use it to get the email address of someone the user wants to invite. " +
    "Directory names are usually written in English: if a Hebrew name finds nothing, try again with the " +
    "English spelling. Returns every match. Exactly one match: use it. Several or none: show the user " +
    "the options (or say nothing was found) and ask who they meant. Never make up an email address.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A name, part of a name, or the start of an email address." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  run: async (args) => {
    const query = String(args.query ?? "").trim();
    if (query.length < 2) throw new Error("query must have at least 2 characters.");

    const accounts = await listAccounts();
    if (accounts.length === 0) throw new Error("No Google account is connected.");

    const results = await Promise.allSettled(accounts.map((account) => searchAccount(account, query)));
    const failed = results.flatMap((result, index) =>
      result.status === "rejected" ? [{ account: accounts[index], error: String((result.reason as Error).message) }] : [],
    );
    if (failed.length === accounts.length) {
      throw new Error(`Could not look people up: ${failed.map((f) => `${f.account}: ${f.error}`).join("; ")}`);
    }

    // The same person can appear in several sources: keep one entry per address.
    const byEmail = new Map<string, Match>();
    for (const match of results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))) {
      if (!byEmail.has(match.email)) byEmail.set(match.email, match);
    }
    return { query, matches: [...byEmail.values()], failed };
  },
};
