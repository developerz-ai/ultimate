// Fixtures first, because the shapes that break a source parser are the rare ones: a function
// prop whose `=>` looks like a closing angle, a union spanning lines, a quoted prop name, and a
// file that exports two components.

import { describe, expect, test } from 'bun:test';
import { headerComment, parseComponents, parseProps } from './parse-component';

const SOURCE = `// A widget.
// Second line of the purpose.

import type { JSX } from 'solid-js';

export interface WidgetProps {
  /** Already-translated label. */
  label: string;
  onPick?: ((value: string, index: number) => void) | undefined;
  size?:
    | 'sm'
    | 'lg'
    | undefined;
  'aria-label'?: string | undefined;
  readonly slots?: { start: JSX.Element } | undefined;
}

export function Widget(props: WidgetProps): JSX.Element {
  return props.label;
}
`;

describe('headerComment', () => {
  test('joins the leading // block and stops at the first import', () => {
    expect(headerComment(SOURCE)).toBe('A widget. Second line of the purpose.');
  });

  test('a file with no header comment reports none', () => {
    expect(headerComment("import x from 'y';\n// not a header\n")).toBe('');
  });
});

describe('parseProps', () => {
  const props = parseProps(SOURCE, 'WidgetProps');

  test('finds every member, in source order', () => {
    expect(props.map((prop) => prop.name)).toEqual([
      'label',
      'onPick',
      'size',
      'aria-label',
      'slots',
    ]);
  });

  test('required is the absence of `?`, not the absence of `| undefined`', () => {
    expect(props.map((prop) => prop.required)).toEqual([true, false, false, false, false]);
  });

  test('`| undefined` is stripped and whitespace collapsed', () => {
    expect(props[2]?.type).toBe("'sm' | 'lg'");
  });

  test('a function type survives its own arrow', () => {
    expect(props[1]?.type).toBe('((value: string, index: number) => void)');
  });

  test('a quoted prop name is unquoted, and `readonly` is not part of the name', () => {
    expect(props[3]?.name).toBe('aria-label');
    expect(props[4]?.name).toBe('slots');
    expect(props[4]?.type).toBe('{ start: JSX.Element }');
  });

  test('doc comments attach to the member below them', () => {
    expect(props[0]?.doc).toBe('Already-translated label.');
    expect(props[1]?.doc).toBe('');
  });

  test('an interface that is not there yields no props rather than throwing', () => {
    expect(parseProps(SOURCE, 'MissingProps')).toEqual([]);
  });
});

describe('parseComponents', () => {
  test('pairs each exported component with its own props interface', () => {
    const docs = parseComponents(SOURCE);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.name).toBe('Widget');
    expect(docs[0]?.props).toHaveLength(5);
  });

  test('a generic component is still a component', () => {
    const source = `// Grid of rows.

export interface GridViewProps<Row> {
  rows: readonly Row[];
}

export function GridView<Row>(props: GridViewProps<Row>): JSX.Element {
  return null;
}
`;
    const docs = parseComponents(source);
    expect(docs.map((doc) => doc.name)).toEqual(['GridView']);
    expect(docs[0]?.props[0]?.type).toBe('readonly Row[]');
  });

  test('two components in one file are both catalogued', () => {
    const source = `// Two things.

export interface OneProps {
  a: string;
}

export interface TwoProps {
  b: string;
}

export function One(props: OneProps) {}

export function Two(props: TwoProps) {}
`;
    expect(parseComponents(source).map((doc) => doc.name)).toEqual(['One', 'Two']);
  });

  test('a plain exported helper is not mistaken for a component', () => {
    const source = `// Helpers.

export function initialsOf(name: string): string {
  return name;
}
`;
    expect(parseComponents(source)).toEqual([]);
  });
});

// One mode per use is a UNION of interfaces over a shared base (`Link`, `Pagination`): the
// catalog has to show every prop a caller may write, and none of the members that exist only to
// forbid one.
describe('a props type that is a union of interfaces', () => {
  const source = `// A pager.

interface PagerBaseProps {
  /** Shared by both modes. */
  class?: string | undefined;
}

export interface PagerCallbackProps extends PagerBaseProps {
  mode?: 'callback' | undefined;
  onCursor?: ((cursor: string) => void) | undefined;
  hrefFor?: undefined;
  tone?: 'accent' | undefined;
}

export interface PagerLinkProps extends PagerBaseProps {
  mode: 'link';
  /** Builds the URL of a page. */
  hrefFor: (cursor: string) => string;
  onCursor?: undefined;
  tone?: Tone | undefined;
}

export type PagerProps = PagerCallbackProps | PagerLinkProps;

export function Pager(props: PagerProps) {}
`;
  const props = parseProps(source, 'PagerProps');
  const named = (name: string) => props.find((prop) => prop.name === name);

  test('lists inherited members first, then each prop once, in the order the modes introduce them', () => {
    expect(props.map((prop) => prop.name)).toEqual([
      'class',
      'mode',
      'onCursor',
      'tone',
      'hrefFor',
    ]);
  });

  test('a member typed `undefined` forbids a prop and is not one', () => {
    expect(named('hrefFor')?.type).toBe('(cursor: string) => string');
    expect(named('onCursor')?.type).toBe('((cursor: string) => void)');
  });

  test('a prop is required only when every mode requires it', () => {
    expect(named('hrefFor')?.required).toBe(false);
    // Optional in one mode and required in the other: a reader choosing a mode may omit it.
    expect(named('mode')).toEqual({
      name: 'mode',
      type: "'callback' | 'link'",
      required: false,
      doc: '',
    });
    expect(parseProps(source, 'PagerLinkProps').find((p) => p.name === 'hrefFor')?.required).toBe(
      true,
    );
  });

  test('a prop typed differently per mode shows both types, and the doc that exists', () => {
    expect(named('tone')?.type).toBe("'accent' | Tone");
    expect(named('hrefFor')?.doc).toBe('Builds the URL of a page.');
    expect(named('class')?.doc).toBe('Shared by both modes.');
  });

  test('the component is catalogued with the merged props', () => {
    expect(parseComponents(source)[0]?.props.map((prop) => prop.name)).toEqual([
      'class',
      'mode',
      'onCursor',
      'tone',
      'hrefFor',
    ]);
  });

  test('an interface extending a base carries the base members', () => {
    expect(parseProps(source, 'PagerLinkProps').map((prop) => prop.name)).toEqual([
      'class',
      'mode',
      'hrefFor',
      'tone',
    ]);
  });
});

describe('a generic props type that is a union of generic interfaces', () => {
  const source = `// A table.

interface GridBaseProps<Row> {
  rows: readonly Row[];
}

export interface GridCallbackProps<Row> extends GridBaseProps<Row> {
  onCursor?: ((cursor: string) => void) | undefined;
  hrefFor?: undefined;
}

export interface GridLinkProps<Row> extends GridBaseProps<Row> {
  hrefFor: (cursor: string) => string;
  onCursor?: undefined;
}

export type GridProps<Row> = GridCallbackProps<Row> | GridLinkProps<Row>;

export function Grid<Row>(props: GridProps<Row>) {}
`;

  test('the type parameter is read past, on the alias, the members and the base', () => {
    expect(parseComponents(source)[0]?.props.map((prop) => [prop.name, prop.required])).toEqual([
      ['rows', true],
      ['onCursor', false],
      ['hrefFor', false],
    ]);
  });
});
