import JSZip from "jszip";

/** The folder every file sits in inside the zip. */
export const ZIP_ROOT = "toolkit";

/** A fixed time for every entry, so the same toolkit always makes the same bytes. */
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1));

/** Packs a toolkit (path to text) into a zip under `toolkit/`. Runs in Node and in the browser. */
export async function toolkitZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  const paths = Object.keys(files).sort();
  // JSZip would add each folder entry itself, stamped with the current time, so two zips made across a second boundary differed.
  const folders = new Set<string>([ZIP_ROOT]);
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) folders.add(`${ZIP_ROOT}/${parts.slice(0, i).join("/")}`);
  }
  for (const folder of [...folders].sort()) zip.file(`${folder}/`, null, { dir: true, date: FIXED_DATE });
  for (const path of paths) zip.file(`${ZIP_ROOT}/${path}`, files[path] as string, { date: FIXED_DATE, createFolders: false });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
