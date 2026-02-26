import pc from "picocolors";

const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";

export const c = noColor
  ? {
    dim: (s: string) => s,
    cyan: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    blue: (s: string) => s,
    magenta: (s: string) => s,
    bold: (s: string) => s,
  }
  : {
    dim: pc.dim,
    cyan: pc.cyan,
    green: pc.green,
    yellow: pc.yellow,
    red: pc.red,
    blue: pc.blue,
    magenta: pc.magenta,
    bold: pc.bold,
  };
