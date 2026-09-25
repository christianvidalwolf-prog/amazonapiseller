/**
 * Minimal dependency-free XLSX writer.
 *
 * Builds a valid .xlsx (Open XML Spreadsheet) file in the browser:
 * a ZIP package (stored, no compression) containing the minimal parts
 * Excel requires. Strings are written as inline strings so no
 * sharedStrings part is needed.
 */

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CONTENT_TYPES = `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // strip control chars that are invalid in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function safeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Hoja1").slice(0, 31);
}

function workbookXml(sheetName: string): string {
  return `${XML_HEADER}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellXml(rowIndex: number, colIndex: number, value: string | number): string {
  const ref = `${columnLetter(colIndex)}${rowIndex}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (value === "" || value === null || value === undefined) {
    return "";
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function worksheetXml(headers: string[], rows: (string | number)[][]): string {
  const allRows = [headers, ...rows];
  const body = allRows
    .map((row, rIdx) => {
      const cells = row
        .map((value, cIdx) => cellXml(rIdx + 1, cIdx, value))
        .join("");
      return `<row r="${rIdx + 1}">${cells}</row>`;
    })
    .join("");

  // column widths: at least as wide as the header text
  const cols = headers
    .map((h, i) => {
      const width = Math.max(10, Math.min(60, h.length + 4));
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    })
    .join("");

  return `${XML_HEADER}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>${cols}</cols>
  <sheetData>${body}</sheetData>
</worksheet>`;
}

/* ---------------- ZIP (stored entries only) ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Build a ZIP archive with stored (uncompressed) entries. */
function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  // fixed DOS timestamp: 2020-01-01 00:00:00
  const dosTime = u16(0);
  const dosDate = u16((1 << 5) | 1);

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    const localHeader = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed to extract
      u16(0x0800), // general purpose flags: UTF-8 names
      u16(0), // compression method: stored
      dosTime,
      dosDate,
      u32(crc),
      u32(entry.data.length),
      u32(entry.data.length),
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
    ]);

    localChunks.push(localHeader, entry.data);

    const centralHeader = concat([
      u32(0x02014b50), // central directory header signature
      u16(20), // version made by
      u16(20), // version needed to extract
      u16(0x0800), // flags: UTF-8
      u16(0), // compression: stored
      dosTime,
      dosDate,
      u32(crc),
      u32(entry.data.length),
      u32(entry.data.length),
      u16(nameBytes.length),
      u16(0), // extra length
      u16(0), // comment length
      u16(0), // disk number start
      u16(0), // internal file attributes
      u32(0), // external file attributes
      u32(offset),
      nameBytes,
    ]);
    centralChunks.push(centralHeader);

    offset += localHeader.length + entry.data.length;
  }

  const centralDirectory = concat(centralChunks);
  const endOfCentralDirectory = concat([
    u32(0x06054b50),
    u16(0), // number of this disk
    u16(0), // disk with central directory
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset), // offset of central directory
    u16(0), // comment length
  ]);

  return concat([...localChunks, centralDirectory, endOfCentralDirectory]);
}

export interface XlsxExportOptions {
  /** File name without extension, e.g. "inventario_2026-09-25". */
  filename: string;
  /** Sheet tab name (max 31 chars). */
  sheetName?: string;
  headers: string[];
  rows: (string | number)[][];
}

/** Generates the .xlsx file bytes for the given tabular data. */
export function buildXlsx(options: XlsxExportOptions): Uint8Array {
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: new TextEncoder().encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: new TextEncoder().encode(ROOT_RELS) },
    { name: "xl/workbook.xml", data: new TextEncoder().encode(workbookXml(options.sheetName || "Hoja1")) },
    { name: "xl/_rels/workbook.xml.rels", data: new TextEncoder().encode(WORKBOOK_RELS) },
    { name: "xl/worksheets/sheet1.xml", data: new TextEncoder().encode(worksheetXml(options.headers, options.rows)) },
  ];
  return buildZip(entries);
}

/** Generates and triggers the browser download of the .xlsx file. */
export function downloadXlsx(options: XlsxExportOptions): void {
  const bytes = buildXlsx(options);
  const blob = new Blob([bytes as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${options.filename}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
