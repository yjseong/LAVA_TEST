// Converts the volcano master list (xlsx) into src/data/volcanoes.json.
//
//   npm run build:master [-- path/to/volcano_master_all.xlsx]
//
// The Python app read the xlsx with pandas at run time. On Vercel there is no pandas (and no persistent
// disk), so the list is converted once here and the JSON is committed. Re-run this when the list changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readXlsxFile from "read-excel-file/node";

const here = path.dirname(fileURLToPath(import.meta.url));
// default: the list in the original Python app (../original_python/ next to web/)
const src = path.resolve(process.argv[2] ?? path.join(here, "..", "..", "original_python", "volcano_master_all.xlsx"));
const out = path.join(here, "..", "src", "data", "volcanoes.json");

const rows = await readXlsxFile(src);
const header = rows[0].map((h) => String(h ?? "").trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`column "${name}" not found in ${src} (columns: ${header.join(", ")})`);
  return i;
};
const iNumber = col("volcano_number");
const iName = col("volcano_name");
const iCountry = col("country");
const iLat = col("latitude");
const iLon = col("longitude");
const iElev = col("elevation");

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const volcanoes = [];
const seen = new Set();
for (const r of rows.slice(1)) {
  const n = num(r[iNumber]);
  if (n === null || n <= 0) continue;
  const lat = num(r[iLat]);
  const lon = num(r[iLon]);
  volcanoes.push({
    n: Math.trunc(n),
    name: String(r[iName] ?? "").trim(),
    country: String(r[iCountry] ?? "").trim(),
    // Volcanoes without coordinates stay in the list (the alert collectors still resolve their names)
    // but are not drawn on the map.
    lat,
    lon,
    elev: num(r[iElev]),
  });
  if (seen.has(Math.trunc(n))) console.warn(`duplicate volcano_number ${n} (${r[iName]})`);
  seen.add(Math.trunc(n));
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(volcanoes));
const drawn = volcanoes.filter((v) => v.lat !== null && v.lon !== null).length;
console.log(`${volcanoes.length} volcanoes (${drawn} with coordinates) -> ${path.relative(process.cwd(), out)}`);
