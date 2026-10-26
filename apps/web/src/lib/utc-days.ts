/** One calendar day, `days` after or before `day`, as `YYYY-MM-DD`. */
export function shiftDay(day: string, days: number): string {
  const instant = new Date(`${day}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/** The inclusive day list ending at `untilDay`, newest last. */
export function windowDays(untilDay: string, count: number): readonly string[] {
  return Array.from({length: count}, (_, index) =>
    shiftDay(untilDay, index - (count - 1)));
}
