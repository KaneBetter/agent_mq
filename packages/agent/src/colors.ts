// Minimal ANSI color helpers for clean status lines. No dependency.
const isTTY = process.stderr.isTTY === true;

function wrap(code: string): (text: string) => string {
  return (text: string) => (isTTY ? `[${code}m${text}[0m` : text);
}

export const color = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

/** Print a clean status line to stderr, keeping stdout free for structured output. */
export function status(line: string): void {
  process.stderr.write(line + "\n");
}

export function info(message: string): void {
  status(`${color.cyan("info")}  ${message}`);
}

export function ok(message: string): void {
  status(`${color.green("ok")}    ${message}`);
}

export function warn(message: string): void {
  status(`${color.yellow("warn")}  ${message}`);
}

export function fail(message: string): void {
  status(`${color.red("fail")}  ${message}`);
}
