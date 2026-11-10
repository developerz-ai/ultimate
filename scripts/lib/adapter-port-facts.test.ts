// The text readers behind `adapter-ports`: export lists split into types and values, the
// `PortValues` fields, and each binding's phase and the module its installer comes from.

import { describe, expect, test } from 'bun:test';
import { maskLiterals, stripComments } from '../../packages/core/src/source-mask';
import {
  declaredIn,
  exportedNames,
  exportPath,
  installerNames,
  portBindings,
  portValueFields,
} from './adapter-port-facts';

describe('adapter-port-facts', () => {
  test('exportedNames splits types from values in every export spelling', () => {
    const source = [
      "export type { JobDriver, JobRecord } from './driver';",
      "export { installJobDriver, type ClaimOptions } from './driver';",
      "export { inner as installAlias } from './x';",
      'export interface LocalStore {}',
      'export type Alias = string;',
      'export function resetJobDriver() {}',
      'export const memoryThing = 1;',
      'export class InProcessTransport {}',
      '// export function installCommented() {}',
      "const text = 'export function installQuoted() {}';",
    ].join('\n');
    expect(exportedNames(maskLiterals(source))).toEqual({
      types: ['Alias', 'ClaimOptions', 'JobDriver', 'JobRecord', 'LocalStore'],
      values: [
        'InProcessTransport',
        'installAlias',
        'installJobDriver',
        'memoryThing',
        'resetJobDriver',
      ],
    });
  });

  test('installerNames keeps set*/configure*/install* values only', () => {
    expect(
      installerNames({
        types: ['SetOptions'],
        values: ['setAuditSink', 'configureAi', 'installClock', 'settle', 'reset', 'installed'],
      }),
    ).toEqual(['setAuditSink', 'configureAi', 'installClock']);
  });

  test('portValueFields reads each PortValues field and its type, and nothing after it', () => {
    const source = [
      'export interface PortValues {',
      '  /** doc with readonly fake: x */',
      '  readonly jobs: JobDriver;',
      '  readonly mail: MailDriver;',
      '}',
      'export interface RuntimeOverrides extends Partial<PortValues> {',
      '  readonly routes?: readonly Route[];',
      '}',
    ].join('\n');
    expect(portValueFields(maskLiterals(source))).toEqual({
      jobs: 'JobDriver',
      mail: 'MailDriver',
    });
    expect(portValueFields(maskLiterals('export interface Other {}'))).toEqual({});
  });

  test('portBindings reads phase, owner, reader and installer module — across both files', () => {
    const main = stripComments(
      [
        "import { installMailDriver } from '@ultimat3/mail/adapter';",
        "import { getAuditSink, setAuditSink } from '@ultimat3/core';",
        'export const PORT_BINDINGS: PortBindings = {',
        '  aiGateway: {',
        "    phase: 'services',",
        "    install: async (g) => (await import('@ultimat3/ai/adapter')).installAiGateway(g),",
        '  },',
        '  auditSink: {',
        "    phase: 'services',",
        '    install: (sink) => { const found = getAuditSink(); setAuditSink(sink); return () => {}; },',
        '  },',
        "  cacheTiers: { phase: 'pending', owner: '@ultimat3/cli: builds them from names' },",
        '  clock: BOOT_PORT_BINDINGS.clock,',
        "  images: { phase: 'read', at: 'serve-web.ts, the /media/* transform' },",
        "  mail: { phase: 'services', install: (driver) => installMailDriver(driver) },",
        '};',
      ].join('\n'),
    );
    const queue = stripComments(
      [
        "import { installClock } from '@ultimat3/core/adapter';",
        'export interface BootPortBindings {',
        "  readonly clock: InstalledBinding<'clock'>;",
        '}',
        'export const BOOT_PORT_BINDINGS: BootPortBindings = {',
        "  clock: { phase: 'boot', install: (clock) => installClock(clock) },",
        '};',
      ].join('\n'),
    );
    expect(portBindings([main, queue])).toEqual({
      aiGateway: {
        phase: 'services',
        detail: 'installAiGateway',
        installerFrom: ['@ultimat3/ai/adapter'],
      },
      auditSink: { phase: 'services', detail: 'setAuditSink', installerFrom: ['@ultimat3/core'] },
      cacheTiers: {
        phase: 'pending',
        detail: '@ultimat3/cli: builds them from names',
        installerFrom: [],
      },
      clock: { phase: 'boot', detail: 'installClock', installerFrom: ['@ultimat3/core/adapter'] },
      images: { phase: 'read', detail: 'serve-web.ts, the /media/* transform', installerFrom: [] },
      mail: {
        phase: 'services',
        detail: 'installMailDriver',
        installerFrom: ['@ultimat3/mail/adapter'],
      },
    });
  });

  test('exportPath reads a string or the bun/import/default condition', () => {
    expect(exportPath('./src/adapter.ts')).toBe('./src/adapter.ts');
    expect(exportPath({ types: './x.d.ts', bun: './src/x.ts' })).toBe('./src/x.ts');
    expect(exportPath({ types: './x.d.ts' })).toBeUndefined();
    expect(exportPath(7)).toBeUndefined();
  });

  test('declaredIn answers for a value, a class and a type; an unread file declares nothing', () => {
    const declared = declaredIn(
      new Map([['a.ts', 'export function memoryX() {}\nexport class Y {}\nexport interface Z {}']]),
    );
    expect(['memoryX', 'Y', 'Z', 'nope'].map((symbol) => declared('a.ts', symbol))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(declared('b.ts', 'memoryX')).toBe(false);
  });
});
