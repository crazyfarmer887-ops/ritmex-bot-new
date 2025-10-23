import React from "react";
import { Box, Text } from "ink";

type Align = "left" | "right";

export interface TableColumn {
  key: string;
  header: string;
  align?: Align;
  minWidth?: number;
}

export interface DataTableProps<Row extends Record<string, unknown>> {
  columns: TableColumn[];
  rows: Row[];
}

function formatCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toString();
    return value.toFixed(4).replace(/\.0+$/, ".0");
  }
  return String(value);
}

// Basic display width calculator for iOS terminals (CJK/Hangul = width 2)
function charDisplayWidth(codePoint: number): number {
  // Control and combining marks
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  // Wide ranges: CJK, Hangul, Hiragana, Katakana, Fullwidth forms, etc.
  if (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x2eff) || // CJK Radicals
    (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK Symbols and Punctuation
    (codePoint >= 0x3040 && codePoint <= 0x309f) || // Hiragana
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) || // Katakana
    (codePoint >= 0x3130 && codePoint <= 0x318f) || // Hangul Compatibility Jamo
    (codePoint >= 0x31a0 && codePoint <= 0x31ff) || // Bopomofo Extended
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Ext A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
    (codePoint >= 0xff01 && codePoint <= 0xff60) || // Fullwidth ASCII variants
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function stringDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    width += charDisplayWidth(cp);
  }
  return width;
}

function pad(text: string, width: number, align: Align): string {
  const visible = stringDisplayWidth(text);
  if (visible >= width) return text;
  const paddingLen = width - visible;
  const padding = " ".repeat(paddingLen);
  return align === "right" ? padding + text : text + padding;
}

export function DataTable<Row extends Record<string, unknown>>({ columns, rows }: DataTableProps<Row>) {
  const widths = columns.map((col) => {
    const headerWidth = stringDisplayWidth(col.header);
    const minWidth = col.minWidth ?? 0;
    const contentWidth = rows.reduce((max, row) => {
      const cell = formatCell(row[col.key]);
      return Math.max(max, stringDisplayWidth(cell));
    }, 0);
    return Math.max(headerWidth, contentWidth, minWidth);
  });

  return (
    <Box flexDirection="column">
      <Text>
        {columns
          .map((col, index) => {
            const width = widths[index] ?? stringDisplayWidth(col.header);
            return pad(col.header, width, col.align ?? "left");
          })
          .join("  ")}
      </Text>
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex}>
          {columns
            .map((col, index) => {
              const align = col.align ?? "left";
              const cell = formatCell(row[col.key]);
              const width = widths[index] ?? Math.max(stringDisplayWidth(col.header), stringDisplayWidth(cell));
              return pad(cell, width, align);
            })
            .join("  ")}
        </Text>
      ))}
    </Box>
  );
}
