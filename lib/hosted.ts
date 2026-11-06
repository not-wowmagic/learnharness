/**
 * Build-time hosted flag for client components (hosted-web wave,
 * 2026-11-06). Next inlines NEXT_PUBLIC_* values when they are read as a
 * static property, so this stays a plain constant.
 *
 * Server enforcement lives in src/core/hosted.ts + src/server/hosted.ts;
 * this flag only hides controls that would be refused anyway.
 */
export const HOSTED = process.env.NEXT_PUBLIC_LH_HOSTED === "1";
