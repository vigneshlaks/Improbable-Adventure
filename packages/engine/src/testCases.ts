/**
 * Runs one check over several named cases inside a single test, and reports every case that failed (not just the first).
 * It stands in for one generated test per parameter set: the assertions are the same, there are just fewer tests.
 */
export function eachCase<T>(cases: ReadonlyArray<readonly [string, T]>, run: (value: T, name: string) => void): void {
  const failures: string[] = [];
  for (const [name, value] of cases) {
    try {
      run(value, name);
    } catch (error) {
      failures.push(`  ${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} of ${cases.length} cases failed:\n${failures.join("\n")}`);
}
