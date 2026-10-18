import JSZip from "jszip";

/** The folder every file sits in inside the zip. */
export const ZIP_ROOT = "toolkit";

/** A fixed time for every entry, so the same toolkit always makes the same bytes. */
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1));

/** Packs a toolkit (path to text) into a zip under `toolkit/`. Runs in Node and in the browser. */
export async function toolkitZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const path of Object.keys(files).sort()) zip.file(`${ZIP_ROOT}/${path}`, files[path] as string, { date: FIXED_DATE });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
