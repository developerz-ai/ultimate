// The one pure half of the router's DOM helpers: the file name a download is saved under. A header
// is somebody else's text, so every malformed shape must come back as a name, never as a throw.
import { describe, expect, test } from 'bun:test';
import {
  anchorOf,
  announcer,
  dispositionName,
  fieldText,
  focusMain,
  formFields,
  handOver,
  isAttachment,
  linkFacts,
  transition,
} from './navigation-dom';
import {
  FakeDocument,
  type FakeElement,
  type FakeForm,
  fakeWindow,
  h,
} from './navigation-dom-fixture';

describe('dispositionName', () => {
  test.each([
    [
      'a malformed escape falls back to filename',
      `attachment; filename="plain.pdf"; filename*=UTF-8''%E0%A4%A.pdf`,
      'plain.pdf',
    ],
    [
      'a path separator never survives',
      'attachment; filename="../../etc/passwd"',
      '.._.._etc_passwd',
    ],
    ['no name at all', 'attachment', ''],
  ])('%s', (_name, header, expected) => {
    expect(dispositionName(header)).toBe(expected);
  });

  test('filename* (RFC 8187) wins, decoded', () => {
    expect(
      dispositionName(
        `attachment; filename="constancia.pdf"; filename*=UTF-8''constancia%20n%C2%BA7.pdf`,
      ),
    ).toBe('constancia nº7.pdf');
    expect(dispositionName('attachment; filename=evidencia.zip')).toBe('evidencia.zip');
  });

  test('attachment is what saves; inline is shown', () => {
    expect(isAttachment('attachment; filename=a.zip')).toBe(true);
    expect(isAttachment('inline')).toBe(false);
    expect(isAttachment('')).toBe(false);
  });
});

// The DOM half, over the fake DOM (`navigation-dom-fixture.ts`).
describe('the DOM helpers', () => {
  const win = (doc: FakeDocument, reduced = false) =>
    Object.assign(
      fakeWindow(doc, 'https://app.test/a', () => Promise.reject(new TypeError('no'))),
      {
        reducedMotion: reduced,
      },
    );

  test('linkFacts: a hover is no click; a click carries its button and modifiers', () => {
    const doc = new FakeDocument(
      [],
      [h('a', { href: '/b', target: '_self', rel: 'external', download: '' })],
    );
    const anchor = doc.body.children[0] as unknown as HTMLAnchorElement;
    const w = win(doc) as unknown as Window;
    expect(linkFacts(w, anchor)).toMatchObject({
      button: 0,
      modified: false,
      download: true,
      rel: 'external',
    });
    const click = {
      button: 1,
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      defaultPrevented: true,
    };
    expect(linkFacts(w, anchor, click as MouseEvent)).toMatchObject({
      href: 'https://app.test/b',
      button: 1,
      modified: true,
      defaultPrevented: true,
      reload: false,
    });
  });

  test('anchorOf: the nearest link; an SVG <a> (no string href) and a non-element are nobody', () => {
    const doc = new FakeDocument([], [h('a', { href: '/b' }, [h('span', {}, 'x')])]);
    const span = doc.body.querySelector('span') as unknown as EventTarget;
    expect((anchorOf(span) as unknown as FakeElement).tagName).toBe('A');
    const svgLike = { closest: () => ({ href: { baseVal: '/b' } }) } as unknown as EventTarget;
    expect(anchorOf(svgLike)).toBeNull();
    expect(anchorOf(null)).toBeNull();
    expect(anchorOf({} as EventTarget)).toBeNull();
  });

  test('fieldText and formFields: a file by its name; a FormData that refuses the submitter', () => {
    expect(fieldText(new File(['x'], 'acta.pdf'))).toBe('acta.pdf');
    expect(fieldText('tutela')).toBe('tutela');
    const doc = new FakeDocument();
    fakeWindow(doc, 'https://app.test/', () => Promise.reject(new TypeError('no')));
    const form = h('form') as FakeForm;
    form.fields = [['q', 'x']];
    const Real = globalThis.FormData;
    let calls = 0;
    (globalThis as unknown as Record<string, unknown>)['FormData'] = class extends Real {
      constructor(target?: unknown, submitter?: unknown) {
        calls += 1;
        if (submitter !== undefined) throw new TypeError('an old browser: one argument only');
        super();
        this.append('from', String((target as FakeForm).fields.length));
      }
    };
    try {
      const fields = formFields(form as unknown as HTMLFormElement, null);
      expect([...fields]).toEqual([['from', '1']]);
      expect(calls).toBe(2);
    } finally {
      (globalThis as unknown as Record<string, unknown>)['FormData'] = Real;
    }
  });

  test('transition: straight through without the API or with reduced motion; inside it otherwise', async () => {
    const plain = new FakeDocument();
    let applied = 0;
    await transition(win(plain) as unknown as Window, () => {
      applied += 1;
    });
    const still = new FakeDocument();
    still.startViewTransition = () => expect.unreachable('reduced motion takes no transition');
    await transition(win(still, true) as unknown as Window, () => {
      applied += 1;
    });
    const moving = new FakeDocument();
    moving.startViewTransition = (update) => {
      update();
      return {
        updateCallbackDone: Promise.resolve(),
        // A skipped transition rejects these two; the helper answers them.
        ready: Promise.reject(new TypeError('skipped')),
        finished: Promise.reject(new TypeError('skipped')),
      };
    };
    await transition(win(moving) as unknown as Window, () => {
      applied += 1;
    });
    await Promise.resolve();
    expect(applied).toBe(3);
  });

  test('focusMain: <main>, else <h1>, tabindex added once; nothing to focus is nothing', () => {
    const withMain = new FakeDocument([], [h('main', { tabindex: '0' })]);
    focusMain(withMain as unknown as Document);
    expect(withMain.activeElement?.getAttribute('tabindex')).toBe('0');
    const withH1 = new FakeDocument([], [h('h1', {}, 'x')]);
    focusMain(withH1 as unknown as Document);
    expect(withH1.activeElement?.getAttribute('tabindex')).toBe('-1');
    const empty = new FakeDocument();
    focusMain(empty as unknown as Document);
    expect(empty.activeElement).toBeNull();
  });

  test('announcer: a polite, atomic, visually hidden region in the body', () => {
    const doc = new FakeDocument();
    const region = announcer(doc as unknown as Document) as unknown as FakeElement;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.style['clipPath']).toBe('inset(50%)');
    expect(doc.body.children).toContain(region);
  });

  test('handOver: an attachment is saved under its name; anything else is shown', () => {
    const doc = new FakeDocument();
    const w = win(doc);
    const created: FakeElement[] = [];
    const make = doc.createElement.bind(doc);
    doc.createElement = (tag: string) => {
      const made = make(tag);
      created.push(made);
      return made;
    };
    handOver(w as unknown as Window, new Blob(['zip']), 'attachment; filename="evidencia.zip"');
    expect(created[0]?.getAttribute('download')).toBe('evidencia.zip');
    expect(created[0]?.clicks).toBe(1);
    expect(w.assigned).toEqual([]);
    handOver(w as unknown as Window, new Blob(['{}']), 'inline');
    expect(w.assigned[0]?.startsWith('blob:')).toBe(true);
  });
});
