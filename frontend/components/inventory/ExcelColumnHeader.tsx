"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";

export type SortDirection = "asc" | "desc" | null;

export interface ExcelColumnFilterProps {
  title: string;
  columnKey: string;
  values: (string | number | undefined | null)[];
  selectedValues: Set<string>;
  onSelectionChange: (newSelected: Set<string>) => void;
  sortDirection: SortDirection;
  onSortChange: (dir: SortDirection) => void;
  align?: "left" | "center" | "right";
  isNumeric?: boolean;
  subtotal?: string | number;
  subtotalLabel?: string;
}

export function ExcelColumnHeader({
  title,
  columnKey,
  values,
  selectedValues,
  onSelectionChange,
  sortDirection,
  onSortChange,
  align = "left",
  isNumeric = false,
  subtotal,
  subtotalLabel,
}: ExcelColumnFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Unique distinct values with occurrence count and string representation
  const distinctStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const val of values) {
      let strKey = "";
      if (val === null || val === undefined || val === "") {
        strKey = "(Vacías / Empty)";
      } else {
        strKey = String(val).trim();
      }
      counts.set(strKey, (counts.get(strKey) || 0) + 1);
    }

    const list = Array.from(counts.entries()).map(([val, count]) => ({
      val,
      count,
    }));

    // Sort distinct values alphabetically or numerically
    list.sort((a, b) => {
      if (a.val === "(Vacías / Empty)") return 1;
      if (b.val === "(Vacías / Empty)") return -1;
      if (isNumeric) {
        const numA = Number.parseFloat(a.val) || 0;
        const numB = Number.parseFloat(b.val) || 0;
        return numA - numB;
      }
      return a.val.localeCompare(b.val, undefined, { numeric: true, sensitivity: "base" });
    });

    return list;
  }, [values, isNumeric]);

  // Filtered distinct items by search term in dropdown
  const filteredDistinct = useMemo(() => {
    if (!searchTerm.trim()) return distinctStats;
    const term = searchTerm.toLowerCase();
    return distinctStats.filter((item) => item.val.toLowerCase().includes(term));
  }, [distinctStats, searchTerm]);

  // Is filter currently active on this column (i.e. not all distinct values are selected)
  const isFilterActive = selectedValues.size > 0 && selectedValues.size < distinctStats.length;

  const handleSelectAll = () => {
    const all = new Set<string>();
    for (const item of distinctStats) {
      all.add(item.val);
    }
    onSelectionChange(all);
  };

  const handleClearAll = () => {
    onSelectionChange(new Set<string>());
  };

  const handleToggleItem = (val: string) => {
    const next = new Set(selectedValues);
    if (next.has(val)) {
      next.delete(val);
    } else {
      next.add(val);
    }
    onSelectionChange(next);
  };

  const handleSelectOnlyEmpty = () => {
    onSelectionChange(new Set(["(Vacías / Empty)"]));
  };

  const handleSelectOnlyNotEmpty = () => {
    const notEmpty = new Set<string>();
    for (const item of distinctStats) {
      if (item.val !== "(Vacías / Empty)") {
        notEmpty.add(item.val);
      }
    }
    onSelectionChange(notEmpty);
  };

  return (
    <th
      className={`py-3 px-3 font-semibold relative select-none align-top ${
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
      }`}
    >
      <div
        className={`inline-flex items-center gap-1.5 cursor-pointer group ${
          align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start"
        }`}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="group-hover:text-slate-200 transition-colors uppercase tracking-wider text-xs">
          {title}
        </span>

        {/* Sort indicator */}
        {sortDirection === "asc" && <span className="text-indigo-400 font-bold text-xs">▲</span>}
        {sortDirection === "desc" && <span className="text-indigo-400 font-bold text-xs">▼</span>}

        {/* Excel Filter Funnel Icon Button */}
        <button
          type="button"
          aria-label={`Filtrar columna ${title}`}
          className={`p-1 rounded transition-colors flex items-center justify-center text-xs ${
            isFilterActive
              ? "bg-indigo-600 text-white shadow-sm ring-1 ring-indigo-400"
              : "text-slate-400 hover:text-slate-100 hover:bg-slate-800"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            setIsOpen((prev) => !prev);
          }}
        >
          <svg
            className={`w-3.5 h-3.5 ${isFilterActive ? "fill-white" : "fill-current"}`}
            viewBox="0 0 24 24"
          >
            <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z" />
          </svg>
        </button>
      </div>

      {/* Subtotal / Filtered Total Under Title */}
      {subtotal !== undefined && (
        <div
          className={`mt-1 font-mono text-[11px] font-semibold tracking-normal normal-case ${
            align === "right"
              ? "text-right text-emerald-400"
              : align === "center"
              ? "text-center text-indigo-300"
              : "text-left text-indigo-300"
          }`}
          title={subtotalLabel ? `${subtotalLabel}: ${subtotal}` : String(subtotal)}
        >
          {subtotal}
          {subtotalLabel && (
            <span className="block text-[9px] font-normal text-slate-500 uppercase tracking-tight">
              {subtotalLabel}
            </span>
          )}
        </div>
      )}

      {/* Excel Dropdown Filter Popover */}
      {isOpen && (
        <div
          ref={popoverRef}
          onClick={(e) => e.stopPropagation()}
          className="absolute z-50 mt-2 w-72 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl p-3 text-left text-xs font-normal normal-case text-slate-200 top-full left-0 max-w-[90vw]"
        >
          {/* Header & Quick Sort */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2">
            <span className="font-semibold text-slate-100 flex items-center gap-1.5">
              <span>📊</span> {title}
            </span>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-slate-400 hover:text-white text-sm leading-none p-0.5"
            >
              ✕
            </button>
          </div>

          {/* Sort Buttons */}
          <div className="grid grid-cols-2 gap-1.5 pb-2 mb-2 border-b border-slate-800">
            <button
              type="button"
              onClick={() => {
                onSortChange("asc");
              }}
              className={`px-2 py-1.5 rounded flex items-center justify-center gap-1 border transition-colors ${
                sortDirection === "asc"
                  ? "bg-indigo-600 border-indigo-500 text-white font-medium"
                  : "bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <span>{isNumeric ? "1 → 9" : "A → Z"}</span>
              <span>Ascendente</span>
            </button>
            <button
              type="button"
              onClick={() => {
                onSortChange("desc");
              }}
              className={`px-2 py-1.5 rounded flex items-center justify-center gap-1 border transition-colors ${
                sortDirection === "desc"
                  ? "bg-indigo-600 border-indigo-500 text-white font-medium"
                  : "bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <span>{isNumeric ? "9 → 1" : "Z → A"}</span>
              <span>Descendente</span>
            </button>
          </div>

          {/* Quick Filter Presets: Todos, Vacías, No Vacías */}
          <div className="flex items-center justify-between gap-1 text-[11px] mb-2 text-indigo-400">
            <button
              type="button"
              onClick={handleSelectAll}
              className="hover:underline hover:text-indigo-300"
            >
              Seleccionar todo
            </button>
            <span>·</span>
            <button
              type="button"
              onClick={handleClearAll}
              className="hover:underline hover:text-slate-300 text-slate-400"
            >
              Limpiar
            </button>
            <span>·</span>
            <button
              type="button"
              onClick={handleSelectOnlyEmpty}
              className="hover:underline hover:text-amber-300 text-amber-400"
            >
              Solo vacíos
            </button>
          </div>

          {/* Search box within column values */}
          <div className="relative mb-2">
            <input
              type="text"
              placeholder={`Buscar en ${title}...`}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                className="absolute right-2 top-1.5 text-slate-400 hover:text-white"
              >
                ✕
              </button>
            )}
          </div>

          {/* Values Checkbox List */}
          <div className="max-h-48 overflow-y-auto space-y-1 pr-1 border border-slate-800 rounded p-1 bg-slate-950/60 divide-y divide-slate-800/40">
            {filteredDistinct.length === 0 ? (
              <div className="p-2 text-slate-500 text-center text-[11px]">
                No hay coincidencias
              </div>
            ) : (
              filteredDistinct.map((item) => {
                const isChecked = selectedValues.has(item.val);
                return (
                  <label
                    key={item.val}
                    className="flex items-center justify-between gap-2 p-1 rounded hover:bg-slate-800/60 cursor-pointer select-none text-[11px]"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => handleToggleItem(item.val)}
                        className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                      />
                      <span
                        className={`truncate ${
                          item.val === "(Vacías / Empty)"
                            ? "italic text-slate-500 font-serif"
                            : "text-slate-200"
                        }`}
                        title={item.val}
                      >
                        {item.val}
                      </span>
                    </div>
                    <span className="text-slate-500 font-mono text-[10px] shrink-0">
                      {item.count}
                    </span>
                  </label>
                );
              })
            )}
          </div>

          {/* Bottom Actions */}
          <div className="mt-3 pt-2 border-t border-slate-800 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                handleSelectAll();
                onSortChange(null);
              }}
              className="text-[11px] text-slate-400 hover:text-slate-200"
            >
              Restablecer columna
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs transition-colors"
            >
              Aplicar
            </button>
          </div>
        </div>
      )}
    </th>
  );
}
