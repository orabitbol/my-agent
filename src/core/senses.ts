// What the desk device senses: the room's temperature and humidity.
// The device reports them twice a minute; this file keeps the latest reading
// and knows when it has gone stale.

const STALE_AFTER_MS = 2 * 60_000; // this long without a report: we know nothing

export type Senses = {
  temperature: number | null; // degrees Celsius, at the device. null: unknown
  humidity: number | null;    // percent. null: unknown
};

let lastReport = 0;
let temperature: number | null = null;
let humidity: number | null = null;

/** Takes one report from the device. Anything that is not a sane number is dropped. */
export function reportSenses(report: Record<string, unknown>, now = Date.now()): void {
  lastReport = now;
  const temp = Number(report.temp), wet = Number(report.humidity);
  temperature = report.temp !== undefined && temp > -20 && temp < 70 ? Math.round(temp * 10) / 10 : null;
  humidity = report.humidity !== undefined && wet >= 0 && wet <= 100 ? Math.round(wet) : null;
}

export function senses(now = Date.now()): Senses {
  const fresh = now - lastReport < STALE_AFTER_MS;
  return { temperature: fresh ? temperature : null, humidity: fresh ? humidity : null };
}

/** For tests: forget everything. */
export function resetSenses(): void {
  lastReport = 0;
  temperature = humidity = null;
}
