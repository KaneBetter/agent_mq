// Hand-rolled arg parser: no dependency. Supports `--flag value`, `--flag=value`,
// and boolean flags (`--once`, `--allow-shell`). Positional args are collected
// in order (used for e.g. `complete <id>`).
export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

/** Parse argv (already sliced past `node script.js`) into positionals + flags. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        flags.set(key, value);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, flags };
}

export function getString(flags: Map<string, string | true>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

export function getBool(flags: Map<string, string | true>, key: string): boolean {
  return flags.has(key);
}

export function getNumber(flags: Map<string, string | true>, key: string): number | undefined {
  const value = getString(flags, key);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function getList(flags: Map<string, string | true>, key: string): string[] | undefined {
  const value = getString(flags, key);
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
