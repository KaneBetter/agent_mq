// Minimal stdin prompt helpers for `login` when --username/--password are
// omitted. Built-in node:readline only, no dependency.
//
// Uses the callback-based node:readline (not readline/promises): with piped
// (non-TTY) stdin, calling `.question()` a second time can silently never
// resolve once the underlying stream has already been fully buffered/ended —
// there is no further 'line' event to fire the callback, and with nothing
// else keeping the event loop alive Node just exits. To avoid that, a single
// 'line' listener queues every line as it arrives; each prompt call takes the
// next queued line if one is already buffered, or waits for the next 'line'
// event otherwise (the interactive-TTY case, one line at a time). There is
// exactly one place lines are consumed from, so no line is ever delivered twice.
import { createInterface, type Interface } from "node:readline";
import { stdin, stdout } from "node:process";

const CTRL_C = ""; // Ctrl+C (ETX)
const BACKSPACE = ""; // Backspace (BS)
const DELETE = ""; // Delete (DEL)

/** A prompt session shares one readline.Interface across multiple questions; call close() once done. */
export class PromptSession {
  private rl: Interface | undefined;
  private queuedLines: string[] = [];
  private waiters: Array<(line: string) => void> = [];

  private interface(): Interface {
    if (!this.rl) {
      const rl = createInterface({ input: stdin, output: stdout });
      rl.on("line", (line) => {
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(line);
        } else {
          this.queuedLines.push(line);
        }
      });
      this.rl = rl;
    }
    return this.rl;
  }

  /** Resolve with the next line: an already-buffered one if available, else the next 'line' event. */
  private nextLine(): Promise<string> {
    this.interface();
    const queued = this.queuedLines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve) => this.waiters.push(resolve));
  }

  /** Prompt for a plain visible line of input (e.g. username). */
  async promptLine(question: string): Promise<string> {
    stdout.write(question);
    const line = await this.nextLine();
    return line.trim();
  }

  /**
   * Prompt for a password, masking keystrokes when stdin is an interactive TTY.
   * Falls back to plain (visible) input when not a TTY (e.g. piped input).
   */
  async promptPassword(question: string): Promise<string> {
    if (!stdin.isTTY) {
      return this.promptLine(question);
    }

    // Masked input needs raw keystroke access, which conflicts with an active
    // readline.Interface reading the same stdin; pause it for the duration.
    this.rl?.pause();
    try {
      return await readMaskedPassword(question);
    } finally {
      this.rl?.resume();
    }
  }

  close(): void {
    this.rl?.close();
    this.rl = undefined;
    this.queuedLines = [];
    this.waiters = [];
  }
}

function readMaskedPassword(question: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let password = "";
    stdout.write(question);

    const cleanup = (): void => {
      stdin.removeListener("data", onKeypress);
      stdin.setRawMode?.(false);
    };

    function onKeypress(chunk: Buffer): void {
      const str = chunk.toString("utf8");
      if (str === CTRL_C) {
        cleanup();
        reject(new Error("aborted"));
        return;
      }
      if (str === "\r" || str === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(password);
        return;
      }
      if (str === BACKSPACE || str === DELETE) {
        password = password.slice(0, -1);
        return;
      }
      password += str;
    }

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onKeypress);
  });
}
