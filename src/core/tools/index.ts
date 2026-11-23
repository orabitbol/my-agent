// The list of tools the agent has. To give the agent a new ability,
// write a tool file and add it here.

import type { Tool } from "./types.js";
import { getCurrentTime } from "./time.js";
import { createCalendarEvent, getCalendarEvents } from "./calendar.js";
import { createEmailDraft, readEmail, searchEmails } from "./mail.js";
import { findPeople } from "./people.js";
import { findFreeRooms } from "./rooms.js";
import { forget, remember } from "./memory.js";

export const tools: Tool[] = [
  getCurrentTime,
  getCalendarEvents,
  findPeople,
  findFreeRooms,
  createCalendarEvent,
  searchEmails,
  readEmail,
  createEmailDraft,
  remember,
  forget,
];
