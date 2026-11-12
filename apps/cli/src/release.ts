import { createHash } from "node:crypto";

/** Parse a `sha256sum`-format SHA256SUMS file into name → lowercase hex digest. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * -1 / 0 / 1 for `a` older / equal / newer than `b`, in SemVer precedence: a
 * leading `v` and `+build` metadata are ignored, and a pre-release sorts
 * before its release (`1.2.3-rc.1` < `1.2.3-rc.2` < `1.2.3`).
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("+")[0]?.split(/-(.*)/s) ?? [];
    return {
      core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      pre: pre ? pre.split(".") : [],
    };
  };
  const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return sign(diff);
  }
  // A release outranks any of its pre-releases.
  if (pa.pre.length === 0 || pb.pre.length === 0) return sign(pb.pre.length - pa.pre.length);
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const [x, y] = [pa.pre[i], pb.pre[i]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1; // numeric identifiers sort first
    return x < y ? -1 : 1;
  }
  return 0;
}
