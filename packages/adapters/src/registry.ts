import type { CliId } from "@weft/schema";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { geminiAdapter } from "./gemini";
import { opencodeAdapter } from "./opencode";
import { cursorAdapter } from "./cursor";
import type { CliAdapter } from "./types";

/** All CLI adapters weft ships. Add a CLI by importing its adapter and adding one line. */
const ADAPTERS: Partial<Record<CliId, CliAdapter>> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
  cursor: cursorAdapter,
};

export function getAdapter(cli: CliId): CliAdapter {
  const adapter = ADAPTERS[cli];
  if (!adapter) {
    throw new Error(
      `weft: no adapter for CLI "${cli}" (supported: ${supportedClis().join(", ")})`,
    );
  }
  return adapter;
}

export function supportedClis(): CliId[] {
  return Object.keys(ADAPTERS) as CliId[];
}

export function isCliSupported(cli: string): cli is CliId {
  return cli in ADAPTERS;
}
