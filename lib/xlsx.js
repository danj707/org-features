/**
 * Minimal .xlsx writer — zero dependencies.
 *
 * org-features has exactly three dependencies (compression, express, pg), and a
 * spreadsheet library is ~5MB for what is, underneath, a ZIP of six XML files.
 * node's own zlib does the compression, so this stays in-repo and adds nothing
 * to the deploy.
 *
 * Supports what a remittance needs and nothing more: multiple sheets, inline
 * strings, numbers, a small style palette, column widths, merges, freeze panes.
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
    const raw = Buffer.from(f.data, "utf8");
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Only take the compressed form when it is actually smaller; a tiny XML
    // file can deflate LARGER than it started, and Excel is fussy about a
    // stored size that disagrees with reality.
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
const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  // Excel refuses a file containing raw control characters; a customer name
  // pasted out of another system can carry one.
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

function colName(n) {
  let s = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/* ── styles ──────────────────────────────────────────────────────────────── */
// Index into this array is the style id used by cells.
const S = {
  DEFAULT: 0, TITLE: 1, ORG: 2, META: 3, SECTION: 4, LABEL: 5, MONEY: 6,
  MONEY_BOLD: 7, INT: 8, TH: 9, TH_R: 10, TOTAL_LBL: 11, TOTAL_MONEY: 12,
  TOTAL_INT: 13, SUB_LBL: 14, SUB_MONEY: 15, PCT: 16, FINAL_LBL: 17,
  FINAL_MONEY: 18, NOTE: 19, DATA: 20, NEG_MONEY: 21, BOLD: 22, BOLD_INT: 23,
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>
<numFmt numFmtId="165" formatCode="0.00%"/>
<numFmt numFmtId="166" formatCode="#,##0"/>
</numFmts>
<fonts count="8">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="16"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><name val="Calibri"/></font>
<font><sz val="10"/><color rgb="FF5A6570"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><i/><sz val="9"/><color rgb="FF7A8592"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><color rgb="FF1F6F43"/><name val="Calibri"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2F4858"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEEF2F5"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8F4EC"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFB9C2CC"/></bottom><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF8A96A3"/></top><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="24">
<xf numFmtId="0"   fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0"   fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0"   fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0"   fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0"   fontId="4" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0"   fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="164" fontId="5" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0"   fontId="5" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0"   fontId="5" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0"   fontId="5" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="5" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="166" fontId="5" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0"   fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment indent="2"/></xf>
<xf numFmtId="164" fontId="3" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0"   fontId="7" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="7" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0"   fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0"   fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="164" fontId="5" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0"   fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="166" fontId="5" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment horizontal="right"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/* ── sheet ───────────────────────────────────────────────────────────────── */
// A cell is null/undefined (empty), a primitive, or {v, s, f}.
function cellXml(ref, cell) {
  if (cell === null || cell === undefined || cell === "") return "";
  const o = (typeof cell === "object" && !(cell instanceof Date)) ? cell : { v: cell };
  const s = o.s ? ` s="${o.s}"` : "";
  if (typeof o.v === "number" && Number.isFinite(o.v)) return `<c r="${ref}"${s}><v>${o.v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`;
}

function sheetXml(sheet) {
  const cols = (sheet.widths || [])
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const rows = sheet.rows.map((row, r) => {
    const cells = (row || []).map((c, i) => cellXml(colName(i) + (r + 1), c)).join("");
    if (!cells) return "";
    const h = sheet.rowHeights && sheet.rowHeights[r]
      ? ` ht="${sheet.rowHeights[r]}" customHeight="1"` : "";
    return `<row r="${r + 1}"${h}>${cells}</row>`;
  }).join("");
  const merges = (sheet.merges || []).length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  const pane = sheet.freeze
    ? `<sheetView workbookViewId="0"><pane ySplit="${sheet.freeze}" topLeftCell="A${sheet.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
    : `<sheetView workbookViewId="0"/>`;
  // Element order inside <worksheet> is fixed by the schema; Excel rejects the
  // file outright if pageSetup precedes sheetData.
  const page = `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>`
    + `<pageSetup paperSize="1" orientation="${sheet.landscape ? "landscape" : "portrait"}" `
    + `fitToWidth="1" fitToHeight="0" scale="100"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews>${pane}</sheetViews>
${cols ? `<cols>${cols}</cols>` : ""}
<sheetData>${rows}</sheetData>${merges}${page}</worksheet>`;
}

function build(sheets) {
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
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
    { name: "xl/styles.xml", data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return zip(files);
}

module.exports = { build, S, colName };
