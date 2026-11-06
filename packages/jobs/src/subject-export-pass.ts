// One `subjectExport()` pass: every table the subject reaches and every target, one object per
// page (`<prefix>/<table>/part-NNNNN.<ext>`), then `<prefix>/index.json` naming each table, its
// count and its treatment. Sealed columns never leave; a page is a step, so a killed run resumes.

import { assert } from '@ultimat3/core';
import { sealedFields } from '@ultimat3/entity';
import { JobAbortedError } from './errors';
import { DEFAULT_EXPORT_MAX_PART_BYTES } from './export';
import { ExportPartTooLargeError } from './export-errors';
import type { ExportFormat, ExportRecord, ExportValue } from './export-format';
import { encodeExportPage } from './export-format';
import type { ExportSink } from './export-sink';
import { exportPartKey } from './export-sink';
import type { StepApi } from './steps-api';
import type { SubjectTargetEntry, SubjectTreatment } from './subject';
import { isRetainedTarget, targetOf } from './subject';
import type { SubjectReader, SubjectRow } from './subject-select';
import { rowIdentity } from './subject-select';

/** One line of the index: what the subject's data in one table is, and what the erase does to it. */
export interface SubjectIndexEntry {
  readonly name: string;
  readonly kind: 'table' | 'target';
  readonly treatment: 'delete' | 'anonymize' | 'retain' | 'erase';
  /** The declared `retain` reason, printed so the person reads why a row is kept. */
  readonly reason?: string;
  readonly rows: number;
  readonly parts: number;
}

export interface SubjectExportReport {
  readonly name: string;
  readonly prefix: string;
  readonly indexKey: string;
  readonly tables: readonly SubjectIndexEntry[];
}

export interface SubjectExportRun {
  readonly name: string;
  readonly runId: string;
  readonly prefix: string;
  readonly format: ExportFormat;
  readonly sink: ExportSink;
  readonly nowMs: () => number;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** One stored value as a cell: an instant as ISO (UTC, zone in the string), structure as JSON. */
export function subjectCell(value: unknown): ExportValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return hex(value);
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'bigint' ? inner.toString() : inner,
  );
}

const treatmentName = (treatment: SubjectTreatment): SubjectIndexEntry['treatment'] =>
  treatment === 'delete' ? 'delete' : 'anonymize' in treatment ? 'anonymize' : 'retain';

interface Part {
  readonly rows: number;
  readonly bytes: number;
}

async function writePart(
  step: StepApi,
  run: SubjectExportRun,
  table: string,
  index: number,
  columns: readonly string[],
  records: readonly ExportRecord[],
): Promise<Part> {
  const stepName = `export:${table}:${index}`;
  return step.run(stepName, async (signal): Promise<Part> => {
    const body = encodeExportPage({
      subject: run.name,
      format: run.format,
      columns,
      records,
      header: index === 0,
    });
    if (body.byteLength > DEFAULT_EXPORT_MAX_PART_BYTES) {
      throw new ExportPartTooLargeError({
        export: run.name,
        part: index,
        bytes: body.byteLength,
        maxBytes: DEFAULT_EXPORT_MAX_PART_BYTES,
      });
    }
    if (signal.aborted) throw new JobAbortedError({ job: run.name, step: stepName });
    await run.sink.put(exportPartKey(`${run.prefix}/${table}`, index, run.format), body);
    return { rows: records.length, bytes: body.byteLength };
  });
}

async function exportTable(
  step: StepApi,
  run: SubjectExportRun,
  reader: SubjectReader,
  entity: string,
) {
  const core = reader.core(entity);
  const sealed = new Set(sealedFields(core).map((field) => field.property));
  const columns = core
    .$describe()
    .columns.map((c) => c.property)
    .filter((p) => !sealed.has(p));
  const seen = new Set<string>();
  let rows = 0;
  let parts = 0;
  for await (const page of reader.pages(entity)) {
    // Deduplicated before the step, so a replay rebuilds exactly the page it checkpointed.
    const fresh = page.filter((row: SubjectRow) => {
      const id = rowIdentity(core, row);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (fresh.length === 0) continue;
    const records = fresh.map((row) =>
      Object.fromEntries(columns.map((c) => [c, subjectCell(row[c])])),
    );
    rows += (await writePart(step, run, entity, parts, columns, records)).rows;
    parts += 1;
  }
  return { rows, parts };
}

async function exportTarget(
  step: StepApi,
  run: SubjectExportRun,
  reader: SubjectReader,
  entry: SubjectTargetEntry,
) {
  const target = targetOf(entry);
  let cursor: string | null = null;
  let rows = 0;
  let parts = 0;
  for (let n = 0; ; n += 1) {
    const at = cursor;
    const page: { rows: number; cursor: string | null } = await step.run(
      `export:target:${target.name}:${n}`,
      async (signal) => {
        const read = await target.exportPage(
          { key: reader.key, row: (await reader.rootRow()) ?? {} },
          at,
          reader.size,
        );
        if (read.rows.length === 0) return { rows: 0, cursor: null };
        if (signal.aborted) throw new JobAbortedError({ job: run.name, step: target.name });
        const body = encodeExportPage({
          subject: run.name,
          format: run.format,
          columns: target.columns,
          records: read.rows,
          header: n === 0,
        });
        await run.sink.put(exportPartKey(`${run.prefix}/${target.name}`, n, run.format), body);
        return { rows: read.rows.length, cursor: read.cursor };
      },
    );
    rows += page.rows;
    if (page.rows > 0) parts += 1;
    cursor = page.cursor;
    if (cursor === null) return { rows, parts };
  }
}

export async function subjectExportPass(
  step: StepApi,
  run: SubjectExportRun,
  reader: SubjectReader,
  targets: readonly SubjectTargetEntry[],
): Promise<SubjectExportReport> {
  assert(
    run.prefix.length > 0 && !run.prefix.startsWith('/') && !run.prefix.includes('..'),
    `subject export "${run.name}" prefix() answered "${run.prefix}", which is not a key prefix`,
    `prefix: (input) => \`exports/\${input.orgId}/\${input.requestId}\`   # on subjectExport("${run.name}"): relative, no leading slash, no ".."`,
  );
  const tables: SubjectIndexEntry[] = [];
  // The subject first: the index reads as the person, then what hangs off them.
  for (const planned of [...reader.plan.steps].reverse()) {
    const { rows, parts } = await exportTable(step, run, reader, planned.entity);
    const treatment = planned.treatment;
    tables.push({
      name: planned.entity,
      kind: 'table',
      treatment: treatmentName(treatment),
      ...(typeof treatment === 'object' && 'retain' in treatment
        ? { reason: treatment.retain }
        : {}),
      rows,
      parts,
    });
  }
  for (const entry of targets) {
    const { rows, parts } = await exportTarget(step, run, reader, entry);
    tables.push({
      name: targetOf(entry).name,
      kind: 'target',
      treatment: isRetainedTarget(entry) ? 'retain' : 'erase',
      ...(isRetainedTarget(entry) ? { reason: entry.retain } : {}),
      rows,
      parts,
    });
  }
  const indexKey = `${run.prefix}/index.json`;
  await step.run('export:index', async (): Promise<null> => {
    const index = {
      export: run.name,
      runId: run.runId,
      subject: reader.plan.subject,
      format: run.format,
      tables,
      // `toISOString()` is UTC and carries its zone: an instant, not a date anybody formats.
      completedAt: new Date(run.nowMs()).toISOString(),
    };
    await run.sink.put(indexKey, new TextEncoder().encode(JSON.stringify(index)));
    return null;
  });
  return { name: run.name, prefix: run.prefix, indexKey, tables };
}
