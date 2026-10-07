// What `factory-names-declarations.ts` reads off a package's source: which top-level names it
// declares, which of them are classes, what a class implements and what a function returns. The
// collision and class rules in `factory-names.ts` are only as good as this reading.

import { describe, expect, test } from 'bun:test';
import { declarationsIn } from './factory-names-declarations';

describe('top-level declarations', () => {
  test('a function, a const, a class and an enum are declared; an indented local is not', () => {
    const found = declarationsIn(
      [
        'export function openAiProvider(input: Input): Provider {',
        '  const t = translatorFor(input.locale);',
        '  return new OpenAiProvider(input);',
        '}',
        'export const DEFAULT_RETRY: RetryPolicy = { attempts: 3 };',
        'const helper = (x: number): number => x;',
        'export abstract class Base {}',
        'export enum Mode { A }',
      ].join('\n'),
    );
    expect([...found.keys()].sort()).toEqual([
      'Base',
      'DEFAULT_RETRY',
      'Mode',
      'helper',
      'openAiProvider',
    ]);
    expect(found.get('Base')?.kind).toBe('class');
    expect(found.get('openAiProvider')?.kind).toBe('value');
  });

  test('a re-export is not a declaration: the binding is the other module’s', () => {
    const found = declarationsIn(
      [
        "export { ANY_HOST, hostDecision } from '@ultimat3/core';",
        "export { t } from '@ultimat3/schema';",
      ].join('\n'),
    );
    expect(found.size).toBe(0);
  });

  test('a class records what it implements, generics and an extends clause skipped', () => {
    const found = declarationsIn(
      [
        'export class AnthropicProvider implements Provider {}',
        'export class Store<T extends { id: string }> extends Base<T> implements Sink<T>, Closeable {',
        '}',
        'export class Plain {}',
      ].join('\n'),
    );
    expect(found.get('AnthropicProvider')?.implements).toEqual(['Provider']);
    expect(found.get('Store')?.implements).toEqual(['Sink', 'Closeable']);
    expect(found.get('Plain')?.implements).toEqual([]);
  });

  test('a function records its declared return type, a Promise unwrapped', () => {
    const found = declarationsIn(
      [
        'export function openAiProvider(input: OpenAiProviderInput = { a: (x) => x }): Provider {}',
        'export async function liveNode<T>(',
        '  options: Options<T> = {},',
        '): Promise<LiveNodeHandle> {}',
        'export const aiEmbedder = (): Embedder => runtime.embedder;',
        'export const later = async <T,>(value: T): Promise<Box<T>> => box(value);',
        'export function untyped(input) { return input; }',
        'export function union(): Provider | undefined {}',
      ].join('\n'),
    );
    expect(found.get('openAiProvider')?.returns).toBe('Provider');
    expect(found.get('liveNode')?.returns).toBe('LiveNodeHandle');
    expect(found.get('aiEmbedder')?.returns).toBe('Embedder');
    expect(found.get('later')?.returns).toBe('Box');
    expect(found.get('untyped')?.returns).toBeUndefined();
    expect(found.get('union')?.returns).toBe('Provider');
  });

  test('a function records its FIRST parameter’s declared type — what a factory takes', () => {
    const found = declarationsIn(
      [
        'export function postgresJobDriver(options: PostgresJobDriverOptions): JobDriver {}',
        'export function memoryJobDriver(options?: Readonly<MemoryJobDriverOptions> = {}): X {}',
        'export const mcpServer = ({ name, tools }: McpServerInput): McpServer => build();',
        'export function pair(a: string, b: Options): X {}',
        'export function none(): X {}',
        'export function lower(input: number): X {}',
      ].join('\n'),
    );
    expect(found.get('postgresJobDriver')?.accepts).toBe('PostgresJobDriverOptions');
    expect(found.get('memoryJobDriver')?.accepts).toBe('MemoryJobDriverOptions');
    expect(found.get('mcpServer')?.accepts).toBe('McpServerInput');
    // Only the first: a factory's input is its first argument, and a later one is not read.
    expect(found.get('pair')?.accepts).toBeUndefined();
    expect(found.get('none')?.accepts).toBeUndefined();
    expect(found.get('lower')?.accepts).toBeUndefined();
  });

  test('a typed const is a value with no return type — it builds nothing', () => {
    const found = declarationsIn('export const DEFAULT_RETRY: RetryPolicy = { attempts: 3 };');
    expect(found.get('DEFAULT_RETRY')?.returns).toBeUndefined();
  });
});
