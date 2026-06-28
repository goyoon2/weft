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

/**
 * Whether the terminal can show 24-bit truecolour (needed for the banner gradient). We trust
 * COLORTERM, which iTerm2 / Windows Terminal / most modern emulators set; Apple Terminal and the
 * like don't, so they fall back to a solid blue. FORCE_COLOR=3 is chalk's "truecolor" level.
 */
export const truecolorOn =
  colorOn && (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || env.FORCE_COLOR === "3");

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

/**
 * A "tag" chip — bold WHITE text on a coloured background, padded a space each side. Like {@link
 * badge} but white-on-colour (rather than black), for labels meant to read as crisp chips — e.g. the
 * harnesses active in the current directory. Degrades to `[text]` when colour is off so piped output
 * still reads sensibly.
 */
export function tag(text: string, variant: keyof typeof BG = "blue"): string {
  if (!colorOn) return `[${text}]`;
  return `\x1b[${BG[variant]}m\x1b[97m\x1b[1m ${text} \x1b[0m`;
}

/**
 * The "WEFT" wordmark in an ANSI-Shadow block font: solid `█` letter faces with a box-drawing
 * (╗╝╚═║…) drop shadow that gives the slab its depth.
 */
const WEFT_ART = [
  "██╗    ██╗███████╗███████╗████████╗",
  "██║    ██║██╔════╝██╔════╝╚══██╔══╝",
  "██║ █╗ ██║█████╗  █████╗     ██║   ",
  "██║███╗██║██╔══╝  ██╔══╝     ██║   ",
  "╚███╔███╔╝███████╗██║        ██║   ",
  " ╚══╝╚══╝ ╚══════╝╚═╝        ╚═╝   ",
] as const;

/** A vertical blue gradient (top → bottom), weft's brand colour: sky-blue down to a vivid blue. */
const GRAD_TOP = [125, 211, 252] as const; // #7DD3FC
const GRAD_BOT = [37, 99, 235] as const; // #2563EB

const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);
const fg = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;

/**
 * Walk a banner line and colour each run: letter faces (`█`) get `faceWrap`, the shadow glyphs get
 * `shadowWrap`, and spaces pass through untouched.
 */
function paintRow(line: string, faceWrap: (s: string) => string, shadowWrap: (s: string) => string): string {
  let out = "";
  for (let i = 0; i < line.length; ) {
    if (line[i] === " ") {
      out += " ";
      i++;
      continue;
    }
    const isFace = line[i] === "█";
    let run = "";
    while (i < line.length && line[i] !== " " && (line[i] === "█") === isFace) {
      run += line[i];
      i++;
    }
    out += isFace ? faceWrap(run) : shadowWrap(run);
  }
  return out;
}

/**
 * The big "WEFT" banner shown atop the main help — a blue gradient slab. On a truecolour terminal
 * each row is a step of the sky→blue gradient, with the box-drawing shadow rendered ~45% darker for
 * depth. Without truecolour it falls back to a two-tone bold-blue/dim slab, and with colour off
 * entirely to a plain `W E F T` so piped output stays readable. Indented two spaces like the rest
 * of the help.
 */
export function banner(): string {
  if (!colorOn) return "  W E F T";
  const rows = WEFT_ART.length;
  return WEFT_ART.map((line, i) => {
    if (!truecolorOn) {
      return `  ${paintRow(line, (s) => c.bold(c.blue(s)), (s) => c.dim(s))}`;
    }
    const t = rows > 1 ? i / (rows - 1) : 0;
    const r = lerp(GRAD_TOP[0], GRAD_BOT[0], t);
    const g = lerp(GRAD_TOP[1], GRAD_BOT[1], t);
    const b = lerp(GRAD_TOP[2], GRAD_BOT[2], t);
    const faceCol = fg(r, g, b);
    const shadowCol = fg(Math.round(r * 0.45), Math.round(g * 0.45), Math.round(b * 0.45));
    return `  ${paintRow(
      line,
      (s) => `\x1b[1m${faceCol}${s}\x1b[22m\x1b[39m`,
      (s) => `${shadowCol}${s}\x1b[39m`,
    )}`;
  }).join("\n");
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
