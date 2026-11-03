"use client";

import {
  type Column,
  type ColumnDef,
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  type RowData,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Every list in the app (docs/HANDOFF.md 4.7), on TanStack Table v9: client-side
// sorting, per-column text filters and pagination. Column definitions contain
// functions, so a page that renders a DataTable must be a Client Component.
//
//   const col = dataTableColumns<RequestRow>();          // module scope
//   const columns = col.columns([
//     col.accessor("description", { header: "Description" }),
//     col.accessor("requested_at", { header: ({ column }) => <SortableHeader column={column} title="Requested" /> }),
//   ]);
//   <DataTable columns={columns} data={rows} filters={[{ column: "description", placeholder: "Search…" }]} />

/** The features every DataTable registers. Stable at module scope, as v9 requires. */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime, basic: sortFn_basic },
  columnFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export type DataTableFeatures = typeof dataTableFeatures;

/** A column helper typed for DataTable. Create it once per row type, at module scope. */
export function dataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}

/** A text filter box above the table, for one string column (by its id / accessor key). */
export type DataTableFilter = { column: string; placeholder: string };

export function DataTable<TData extends RowData>({
  columns,
  data,
  filters = [],
  pageSize = 20,
  emptyMessage = "No rows.",
}: {
  /** From dataTableColumns<Row>().columns([...]); keep it stable (module scope or useMemo). */
  columns: ColumnDef<DataTableFeatures, TData>[];
  data: TData[];
  filters?: DataTableFilter[];
  pageSize?: number;
  emptyMessage?: string;
}) {
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    initialState: { pagination: { pageIndex: 0, pageSize } },
  });

  const rowCount = table.getFilteredRowModel().rows.length;
  const pageCount = Math.max(table.getPageCount(), 1);
  const rows = table.getRowModel().rows;

  return (
    <div className="flex flex-col gap-3">
      {filters.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <Input
              key={f.column}
              placeholder={f.placeholder}
              aria-label={f.placeholder}
              value={String(table.getColumn(f.column)?.getFilterValue() ?? "")}
              onChange={(e) => table.getColumn(f.column)?.setFilterValue(e.target.value)}
              className="h-8 w-full sm:w-56"
            />
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id} className="h-9 whitespace-nowrap">
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length > 0 ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className="py-1.5">
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <span>
          {rowCount} {rowCount === 1 ? "row" : "rows"}
        </span>
        <div className="flex items-center gap-2">
          <span>
            Page {table.state.pagination.pageIndex + 1} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A clickable column header that sorts ascending, then descending. Use it as a column's `header`. */
export function SortableHeader<TData extends RowData, TValue>({
  column,
  title,
}: {
  column: Column<DataTableFeatures, TData, TValue>;
  title: string;
}) {
  const sorted = column.getIsSorted();
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <Button variant="ghost" size="sm" className="-ml-2 h-7 px-2" onClick={() => column.toggleSorting(sorted === "asc")}>
      {title}
      <Icon className="size-3.5 text-muted-foreground" />
    </Button>
  );
}
