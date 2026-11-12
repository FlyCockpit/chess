import { z } from "zod";

/**
 * Like `originUrl`, but tolerates a path — for values that name a *service
 * endpoint* rather than a browser origin.
 *
 * `BACKUP_S3_ENDPOINT` may point at a reverse-proxied MinIO or Ceph
 * gateway such as `https://s3.example.com/minio`. Require an http(s)
 * scheme so malformed endpoints fail during validation.
 *
 * No `.transform()` here: the path is meaningful to the SDK, so the value is
 * passed through exactly as configured.
 */
export function httpUrl(label: string) {
  return z
    .url()
    .refine(
      (value) => {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      },
      { message: `${label} must use http or https.` },
    )
    .refine(
      (value) => {
        const parsed = new URL(value);
        return !parsed.username && !parsed.password;
      },
      { message: `${label} must not include credentials.` },
    );
}

export function originUrl(label: string) {
  return z
    .url()
    .refine(
      (value) => {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      },
      { message: `${label} must use http or https.` },
    )
    .refine(
      (value) => {
        const parsed = new URL(value);
        return !parsed.username && !parsed.password;
      },
      { message: `${label} must not include credentials.` },
    )
    .refine(
      (value) => {
        const parsed = new URL(value);
        return parsed.pathname === "/" && !parsed.search && !parsed.hash;
      },
      { message: `${label} must be an origin only, with no path, query, or hash.` },
    )
    .transform((value) => new URL(value).origin);
}
