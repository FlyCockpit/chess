import pkg from "../package.json" with { type: "json" };

/** The CLI's own version. Releases are tagged `v<VERSION>` (release.yml checks it). */
export const VERSION: string = pkg.version;
