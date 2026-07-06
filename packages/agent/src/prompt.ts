// Minimal stdin prompt helpers for `login` when --username/--password are
// omitted. Built-in node:readline only, no dependency.
//
// Uses the callback-based node:readline (not readline/promises): with piped
// (non-TTY) stdin, readline/promises' sequential `.question()` calls can hang
// after the first call once the underlying stream reports end-of-input, even
// though more buffered lines remain. The callback API's event-driven `line`
// handling does not have this issue, so we wrap it in a promise ourselves.
import { createInterface, type Interface } from "node:readline";
import { stdin, stdout } from "node:process";

const CTRL_C = ""; // Ctrl+C (ETX)
const BACKSPACE = ""; // Backspace (BS)
const DELETE = ""; // Delete (DEL)

/** A prompt session shares one readline.Interface across multiple questions; call close() once done. */
export class PromptSession {
  private rl: Interface | undefined;

  private interface(): Interface {
    if (!this.rl) {
      this.rl = createInterface({ input: stdin, output: stdout });
    }
    return this.rl;
  }

  /** Prompt for a plain visible line of input (e.g. username). */
  promptLine(question: string): Promise<string> {
    const rl = this.interface();
    return new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
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
