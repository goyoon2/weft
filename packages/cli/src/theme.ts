/**
 * Tiny, dependency-free ANSI styling for the CLI.
 *
 * Colour turns on only for an interactive TTY (and never when NO_COLOR is set), so piped or
 * redirected output — tests, `| cat`, anything reading `--json` — stays plain text. Set
 * FORCE_COLOR=1 to preview the styling through a pipe.
 */
const env = process.env;

function colorEnabled(): boolean {
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "0" || env.FORCE_COLOR === "false") return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== "") return true;
  return Boolean(process.stdout.isTTY) && env.TERM !== "dumb";
}

/** Whether ANSI colour is active for this process (decided once, at load). */
export const colorOn = colorEnabled();

type Style = (s: string) => string;
const sgr =
  (open: number, close: number): Style =>
  (s) =>
    colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : s;

/** Foreground colours + text attributes. Each is a no-op when colour is off. */
export const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
} as const;

const BG: Record<string, number> = {
  green: 42,
  yellow: 43,
  blue: 44,
  red: 41,
  cyan: 46,
  magenta: 45,
  gray: 100,
};

/**
 * A filled badge — bold black text on a coloured background, padded a space each side. When colour
 * is off it degrades to `[text]` so piped output still reads sensibly.
 */
export function badge(text: string, variant: keyof typeof BG = "blue"): string {
  if (!colorOn) return `[${text}]`;
  return `\x1b[${BG[variant]}m\x1b[30m\x1b[1m ${text} \x1b[0m`;
}

/** Status glyphs and line prefixes, pre-coloured for the current process. */
export const sym = {
  ok: c.green("✓"),
  err: c.red("✗"),
  warn: c.yellow("!"),
  skip: c.gray("–"),
  bullet: c.gray("•"),
  arrow: c.gray("→"),
  on: c.green("●"),
  off: c.gray("○"),
  sep: c.gray("·"),
} as const;
