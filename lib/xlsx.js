/**
 * Minimal .xlsx writer — zero dependencies.
 *
 * org-features has exactly three dependencies (compression, express, pg), and a
 * spreadsheet library is ~5MB for what is, underneath, a ZIP of a few XML files.
 * node's own zlib does the compression, so this stays in-repo and adds nothing
 * to the deploy.
 *
 * Supports what a remittance needs and nothing more: multiple sheets, inline
 * strings, numbers, FORMULAS WITH CACHED VALUES, an open-ended style palette,
 * column widths, row heights, merges, freeze panes, gridline suppression and
 * one anchored image.
 *
 * STYLES ARE DESCRIBED, NOT ENUMERATED. A cell asks for {b, i, sz, color, fill,
 * fmt, h, v} and the workbook interns that into a cellXfs entry. The previous
 * version had a fixed palette of 24 ids, and reproducing the finance sheet
 * needs ~70 combinations of six axes — a fixed list either explodes or starts
 * quietly reusing the nearest match.
 */
const zlib = require("zlib");

/* ── ZIP ─────────────────────────────────────────────────────────────────── */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    // Data is a string for the XML parts and a Buffer for an embedded image.
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Only take the compressed form when it is actually smaller; a tiny XML
    // file can deflate LARGER than it started, and a PNG is already
    // compressed — and Excel is fussy about a stored size that disagrees
    // with reality.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8); lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(sum, 14); lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(raw.length, 22); lfh.writeUInt16LE(name.length, 26); lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, name, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8); cdh.writeUInt16LE(method, 10); cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14); cdh.writeUInt32LE(sum, 16); cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(raw.length, 24); cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(0, 38); cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);

    offset += lfh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

/* ── XML ─────────────────────────────────────────────────────────────────── */
// Control characters are not representable in XML 1.0 at all — not even
// escaped — so a stray one in a customer name would make the whole file
// unopenable rather than showing a odd character.
const esc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function colName(n) {
  let s = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/* ── styles ──────────────────────────────────────────────────────────────── */
// A style DESCRIPTOR, with every field optional:
//   b/i     bold / italic          sz     point size          color  "FF202020"
//   name    font family            fill   solid fill hex      fmt    number format
//   h/v     horizontal / vertical alignment      wrap
const FONT_DEFAULTS = { sz: 11, color: "FF000000", name: "Calibri" };

function styleBook() {
  const fmtIds = new Map();       // format code -> numFmtId
  const fonts = new Map();        // key -> index
  const fills = new Map();
  const xfs = new Map();
  const fontXml = [], fillXml = [], xfXml = [];

  // Excel requires fill 0 = none and fill 1 = gray125, in that order, whether
  // or not anything uses them.
  fillXml.push(`<fill><patternFill patternType="none"/></fill>`,
               `<fill><patternFill patternType="gray125"/></fill>`);
  fills.set("__none", 0);

  function fontId(d) {
    const f = { sz: d.sz || FONT_DEFAULTS.sz, color: d.color || FONT_DEFAULTS.color,
                name: d.name || FONT_DEFAULTS.name, b: !!d.b, i: !!d.i };
    const key = JSON.stringify(f);
    if (fonts.has(key)) return fonts.get(key);
    const id = fontXml.length;
    fontXml.push(`<font>${f.b ? "<b/>" : ""}${f.i ? "<i/>" : ""}`
      + `<sz val="${f.sz}"/><color rgb="${f.color}"/><name val="${esc(f.name)}"/></font>`);
    fonts.set(key, id);
    return id;
  }

  function fillId(hex) {
    if (!hex) return 0;
    if (fills.has(hex)) return fills.get(hex);
    const id = fillXml.length;
    fillXml.push(`<fill><patternFill patternType="solid">`
      + `<fgColor rgb="${hex}"/><bgColor indexed="64"/></patternFill></fill>`);
    fills.set(hex, id);
    return id;
  }

  function fmtId(code) {
    if (!code) return 0;
    if (fmtIds.has(code)) return fmtIds.get(code);
    const id = 164 + fmtIds.size;
    fmtIds.set(code, id);
    return id;
  }

  // 0 is the default cell format, and Excel wants it to exist even when
  // nothing references it.
  xfs.set("__default", 0);
  xfXml.push(`<xf numFmtId="0" fontId="${fontId({})}" fillId="0" borderId="0" xfId="0"/>`);

  function id(desc) {
    if (!desc) return 0;
    const key = JSON.stringify([desc.b, desc.i, desc.sz, desc.color, desc.name,
                                desc.fill, desc.fmt, desc.h, desc.v, desc.wrap]);
    if (xfs.has(key)) return xfs.get(key);
    const nf = fmtId(desc.fmt), fo = fontId(desc), fi = fillId(desc.fill);
    const alignAttrs = [
      desc.h ? `horizontal="${desc.h}"` : "",
      desc.v ? `vertical="${desc.v}"` : "",
      desc.wrap ? `wrapText="1"` : "",
    ].filter(Boolean).join(" ");
    const n = xfXml.length;
    xfXml.push(`<xf numFmtId="${nf}" fontId="${fo}" fillId="${fi}" borderId="0" xfId="0"`
      + ` applyNumberFormat="${nf ? 1 : 0}" applyFont="1" applyFill="${fi ? 1 : 0}"`
      + (alignAttrs ? ` applyAlignment="1"><alignment ${alignAttrs}/></xf>` : `/>`));
    xfs.set(key, n);
    return n;
  }

  function xml() {
    const numFmts = [...fmtIds.entries()]
      .map(([code, i]) => `<numFmt numFmtId="${i}" formatCode="${esc(code)}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${numFmts ? `<numFmts count="${fmtIds.size}">${numFmts}</numFmts>` : ""}
<fonts count="${fontXml.length}">${fontXml.join("")}</fonts>
<fills count="${fillXml.length}">${fillXml.join("")}</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfXml.length}">${xfXml.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }

  return { id, xml };
}

/* ── sheet ───────────────────────────────────────────────────────────────── */
// A cell is null/undefined/"" (empty), a primitive, or {v, s, f} where s is a
// style descriptor and f a formula (written WITHOUT the leading "=").
function cellXml(ref, cell, sid) {
  if (cell === null || cell === undefined || cell === "") return "";
  const o = (typeof cell === "object" && !(cell instanceof Date)) ? cell : { v: cell };
  // A styled-but-valueless cell still has to be written: the zebra striping on
  // the finance sheet is carried by cells that hold nothing.
  if ((o.v === null || o.v === undefined || o.v === "") && !o.f && !o.s) return "";
  const s = o.s ? ` s="${sid(o.s)}"` : "";
  // A formula CARRIES ITS COMPUTED VALUE. Excel recalculates on open, but
  // everything else that reads the file — a PDF renderer, a CSV converter,
  // Sheets on import, this repo's own spec — reads the cached <v>, and a
  // formula with no cached value shows up as blank in all of them.
  const f = o.f ? `<f>${esc(o.f)}</f>` : "";
  if (typeof o.v === "number" && Number.isFinite(o.v)) return `<c r="${ref}"${s}>${f}<v>${o.v}</v></c>`;
  if (o.v === null || o.v === undefined || o.v === "") return `<c r="${ref}"${s}>${f}</c>`;
  if (f) return `<c r="${ref}"${s} t="str">${f}<v>${esc(o.v)}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`;
}

function sheetXml(sheet, sid, hasDrawing) {
  const cols = (sheet.widths || [])
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const rows = sheet.rows.map((row, r) => {
    const cells = (row || []).map((c, i) => cellXml(colName(i) + (r + 1), c, sid)).join("");
    const h = sheet.rowHeights && sheet.rowHeights[r]
      ? ` ht="${sheet.rowHeights[r]}" customHeight="1"` : "";
    if (!cells && !h) return "";
    return `<row r="${r + 1}"${h}>${cells}</row>`;
  }).join("");
  const merges = (sheet.merges || []).length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  const grid = sheet.gridlines === false ? ` showGridLines="0"` : "";
  const pane = sheet.freeze
    ? `<sheetView${grid} workbookViewId="0"><pane ySplit="${sheet.freeze}" topLeftCell="A${sheet.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
    : `<sheetView${grid} workbookViewId="0"/>`;
  // Element order inside <worksheet> is fixed by the schema; Excel rejects the
  // file outright if pageSetup precedes sheetData, or <drawing> precedes
  // pageSetup.
  const page = `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>`
    + `<pageSetup paperSize="1" orientation="${sheet.landscape ? "landscape" : "portrait"}" `
    + `fitToWidth="1" fitToHeight="0" scale="100"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews>${pane}</sheetViews>
${cols ? `<cols>${cols}</cols>` : ""}
<sheetData>${rows}</sheetData>${merges}${page}${hasDrawing ? `<drawing r:id="rId1"/>` : ""}</worksheet>`;
}

// One image, anchored to a cell, sized in points. oneCellAnchor rather than
// twoCellAnchor so the logo keeps its size when a column is widened.
const EMU_PER_PT = 12700;
function drawingXml(img) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<xdr:oneCellAnchor>
<xdr:from><xdr:col>${img.col}</xdr:col><xdr:colOff>${Math.round((img.colOff || 0) * EMU_PER_PT)}</xdr:colOff><xdr:row>${img.row}</xdr:row><xdr:rowOff>${Math.round((img.rowOff || 0) * EMU_PER_PT)}</xdr:rowOff></xdr:from>
<xdr:ext cx="${Math.round(img.w * EMU_PER_PT)}" cy="${Math.round(img.h * EMU_PER_PT)}"/>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="${esc(img.name || "logo")}"/><xdr:cNvPicPr preferRelativeResize="0"/></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></xdr:spPr></xdr:pic>
<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;
}

function build(sheets) {
  const book = styleBook();
  const sid = (desc) => book.id(desc);
  // Styles have to be interned BEFORE styles.xml is emitted, so render every
  // sheet first and keep the XML.
  const drawn = sheets.map((s, i) => ({ s, i, xml: sheetXml(s, sid, !!s.image) }));
  const imgs = sheets.map((s, i) => (s.image ? { ...s.image, sheet: i } : null)).filter(Boolean);

  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
${imgs.map((im, n) => `<Override PartName="/xl/drawings/drawing${n + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join("\n")}
</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
${sheets.some(s => s.freeze) ? `<definedNames>${sheets.map((s, i) => s.freeze
  ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${esc(s.name).replace(/'/g, "''")}'!$1:$${s.freeze}</definedName>` : "").join("")}</definedNames>` : ""}
</workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: "xl/styles.xml", data: book.xml() },
    ...drawn.map(({ xml }, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
  ];
  imgs.forEach((im, n) => {
    files.push(
      { name: `xl/worksheets/_rels/sheet${im.sheet + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n + 1}.xml"/>
</Relationships>` },
      { name: `xl/drawings/drawing${n + 1}.xml`, data: drawingXml(im) },
      { name: `xl/drawings/_rels/drawing${n + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n + 1}.png"/>
</Relationships>` },
      { name: `xl/media/image${n + 1}.png`, data: im.data },
    );
  });
  return zip(files);
}

module.exports = { build, colName, styleBook };
