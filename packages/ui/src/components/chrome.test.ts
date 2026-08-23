// The page chrome: the frame, the labelled control, the form summary, the two message surfaces.
// Every claim here is an accessibility-tree one, because that is the half a screenshot cannot
// check and the half these components exist to get right.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FRAMEWORK_CATALOG } from '@ultimat3/i18n';
import { UI_KEYS } from '../i18n-keys';
import { attachRef, byTag, fire, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import type { SolidContext } from '../theme/solid-adapter';
import { Alert } from './Alert';
import { AppShell } from './AppShell';
import { Field } from './Field';
import { Form } from './Form';
import { Tabs } from './Tabs';
import { Toast } from './Toast';

/**
 * What this component must render for a ui key, looked up BY THE KEY in the catalog it ships in.
 *
 * These assertions read `⟦ui.x⟧` until 5.1.0, because `registerFrameworkCatalog()` had one caller
 * and a unit test was never it — so every framework string was a loud miss here and the marker was
 * the only observable. It is registered by importing `@ultimat3/i18n` now, so the marker is gone;
 * the KEY is still what is asserted, which is what these tests are about.
 */
const uiString = (key: string): string => FRAMEWORK_CATALOG[key] ?? `no catalog entry for ${key}`;

/**
 * `<Form>` reaches for a runtime only to schedule the focus move, so this is the smallest one that
 * behaves the way Solid does in the one way the component depends on: effects run after the tree.
 */
function formRuntime(): { flush(): void; restore(): void } {
  const effects: (() => void)[] = [];
  setSolidRuntime({
    createContext: <T>(defaultValue: T): SolidContext<T> => ({
      id: Symbol('test.context'),
      defaultValue,
      Provider: (props: { children?: unknown }) => props.children as never,
    }),
    useContext: <T>(context: SolidContext<T>): T => context.defaultValue,
    createSignal: <T>(value: T) => {
      let current = value;
      const set = (next: T): void => {
        current = next;
      };
      return [(): T => current, set] as [() => T, (next: T) => void];
    },
    createMemo: <T>(fn: () => T) => fn,
    createEffect: (fn: () => void): void => void effects.push(fn),
    onCleanup: (): void => undefined,
  });
  return {
    flush: () => {
      for (const effect of effects) effect();
    },
    restore: clearSolidRuntime,
  };
}

describe('the page chrome', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the components under test compile to a JSX factory this file understands', () => {
    expect(renderNodes(AppShell, { children: 'body' }).length).toBeGreaterThan(0);
  });

  describe('AppShell', () => {
    test('the skip link is the first tab stop and points at the main landmark', () => {
      const nodes = renderNodes(AppShell, { children: 'body' });
      const skip = one(byTag(nodes, 'a'), 'skip link');
      const main = one(byTag(nodes, 'main'), '<main>');

      expect(skip.props['children']).toBe(uiString(UI_KEYS.skip));
      expect(skip.props['href']).toBe(`#${main.props['id']}`);
      // -1 is what makes the skip link move FOCUS and not only the viewport.
      expect(main.props['tabindex']).toBe(-1);
    });

    test('a header and a sidebar are rendered only when given, and the nav is named', () => {
      const bare = renderNodes(AppShell, { children: 'body' });
      expect(byTag(bare, 'header')).toEqual([]);
      expect(byTag(bare, 'nav')).toEqual([]);

      const full = renderNodes(AppShell, {
        children: 'body',
        header: 'top',
        sidebar: 'links',
      });
      expect(one(byTag(full, 'header'), '<header>').props['children']).toBe('top');
      expect(one(byTag(full, 'nav'), '<nav>').props['aria-label']).toBe(
        uiString(UI_KEYS.navigation),
      );
    });

    test('the sidebar name and the skip label are overridable, in the caller’s language', () => {
      const nodes = renderNodes(AppShell, {
        children: 'body',
        sidebar: 'links',
        sidebarLabel: 'Sections',
        skipLabel: 'Skip to content',
      });
      expect(one(byTag(nodes, 'nav'), '<nav>').props['aria-label']).toBe('Sections');
      expect(one(byTag(nodes, 'a'), 'skip link').props['children']).toBe('Skip to content');
    });

    test('the sidebar track is a CSS length, defaulted rather than hardcoded per screen', () => {
      const style = (width?: string): Record<string, string> =>
        renderNodes(AppShell, {
          children: 'body',
          ...(width === undefined ? {} : { sidebarWidth: width }),
        })[0]?.props['style'] as Record<string, string>;
      expect(style()['--shell-sidebar']).toBe('16rem');
      expect(style('22rem')['--shell-sidebar']).toBe('22rem');
    });
  });

  describe('Field', () => {
    test('hands its control the id it labelled, and no describedby it did not render', () => {
      let control: Record<string, unknown> = {};
      const nodes = renderNodes(Field, {
        label: 'Email',
        children: (c: Record<string, unknown>) => {
          control = c;
          return null;
        },
      });

      expect(control['id']).toBe(one(byTag(nodes, 'label'), '<label>').props['for']);
      expect(control['aria-describedby']).toBeUndefined();
      expect(control['aria-invalid']).toBe(false);
      expect(control['required']).toBe(false);
    });

    test('a hint and an error are both announced with the control, in that order', () => {
      let control: Record<string, unknown> = {};
      const nodes = renderNodes(Field, {
        label: 'Email',
        hint: 'Work address',
        error: 'Not an email',
        children: (c: Record<string, unknown>) => {
          control = c;
          return null;
        },
      });

      const paragraphs = byTag(nodes, 'p');
      expect(paragraphs.map((node) => node.props['children'])).toEqual([
        'Work address',
        'Not an email',
      ]);
      expect(control['aria-describedby']).toBe(
        paragraphs.map((node) => node.props['id']).join(' '),
      );
      expect(control['aria-invalid']).toBe(true);
      // The error is announced the moment it appears, which `role="alert"` is what does.
      expect(paragraphs[1]?.props['role']).toBe('alert');
    });

    test('required renders a marker with a translated title, not a bare asterisk', () => {
      const nodes = renderNodes(Field, { label: 'Email', required: true, children: () => null });
      const marker = one(withAttr(nodes, 'title'), 'required marker');
      expect(marker.props['children']).toBe('*');
      expect(marker.props['title']).toBe(uiString(UI_KEYS.required));
    });

    test('markOptional renders the translated marker instead', () => {
      const nodes = renderNodes(Field, {
        label: 'Nickname',
        markOptional: true,
        children: () => null,
      });
      expect(byTag(nodes, 'span').map((node) => node.props['children'])).toEqual([
        uiString(UI_KEYS.optional),
      ]);
      expect(withAttr(nodes, 'title')).toEqual([]);
    });
  });

  describe('Form', () => {
    test('the error summary is described by the form, and absent without an error', () => {
      const bare = renderNodes(Form, { children: null });
      expect(bare[0]?.props['aria-describedby']).toBeUndefined();
      expect(withAttr(bare, 'tabindex', '-1')).toEqual([]);

      const failed = renderNodes(Form, { children: null, error: 'Check the fields above' });
      const summary = one(withAttr(failed, 'tabindex', '-1'), 'error summary');
      expect(failed[0]?.props['aria-describedby']).toBe(summary.props['id']);
    });

    test('a failed submit moves focus to the summary, once the tree exists', () => {
      // `summaryId` is internal, so no caller could ever aim at it; the component has to. The
      // effect is DOM work, so it runs after the tree — not during the render.
      const rt = formRuntime();
      try {
        const nodes = renderNodes(Form, { children: null, error: 'Check the fields above' });
        let focused = 0;
        attachRef(one(withAttr(nodes, 'tabindex', '-1'), 'error summary'), {
          focus: () => (focused += 1),
        });
        expect(focused).toBe(0);

        rt.flush();
        expect(focused).toBe(1);
      } finally {
        rt.restore();
      }
    });

    test('a form with no error moves focus nowhere', () => {
      const rt = formRuntime();
      try {
        renderNodes(Form, { children: null });
        expect(() => rt.flush()).not.toThrow();
        expect(withAttr(renderNodes(Form, { children: null }), 'tabindex', '-1')).toEqual([]);
      } finally {
        rt.restore();
      }
    });

    test('posts by default, and carries the gap as a space-scale step', () => {
      const form = renderNodes(Form, { children: null })[0];
      expect(form?.props['method']).toBe('post');
      expect(form?.props['novalidate']).toBe(false);
      expect(form?.props['style']).toEqual({ '--form-gap': 'var(--space-5)' });
      expect(renderNodes(Form, { children: null, gap: 2 })[0]?.props['style']).toEqual({
        '--form-gap': 'var(--space-2)',
      });
    });
  });

  describe('Tabs', () => {
    const items = [
      { id: 'one', label: 'One', panel: 'p1' },
      { id: 'two', label: 'Two', panel: 'p2' },
    ];
    const tabs = (extra: Record<string, unknown> = {}): ReturnType<typeof renderNodes> =>
      renderNodes(Tabs, { items, value: 'one', onChange: (): void => undefined, ...extra });

    test('every tab controls the panel that names it back', () => {
      const nodes = tabs();
      const tabButtons = withAttr(nodes, 'role', 'tab');
      const panels = withAttr(nodes, 'role', 'tabpanel');

      expect(tabButtons.map((node) => node.props['aria-controls'])).toEqual(
        panels.map((node) => node.props['id']),
      );
      expect(panels.map((node) => node.props['aria-labelledby'])).toEqual(
        tabButtons.map((node) => node.props['id']),
      );
    });

    test('only the selected tab is selected, and only its panel is visible', () => {
      const nodes = tabs({ value: 'two' });
      expect(withAttr(nodes, 'role', 'tab').map((node) => node.props['aria-selected'])).toEqual([
        'false',
        'true',
      ]);
      expect(withAttr(nodes, 'role', 'tabpanel').map((node) => node.props['hidden'])).toEqual([
        true,
        false,
      ]);
    });

    test('choosing a tab reports the id, not the index', () => {
      const chosen: string[] = [];
      const nodes = tabs({ onChange: (id: string) => void chosen.push(id) });
      fire(withAttr(nodes, 'role', 'tab')[1] as never, 'onClick', {});
      expect(chosen).toEqual(['two']);
    });

    test('the tablist declares its orientation, so arrows match the axis', () => {
      expect(one(withAttr(tabs(), 'role', 'tablist'), 'tablist').props['aria-orientation']).toBe(
        'horizontal',
      );
      expect(
        one(withAttr(tabs({ orientation: 'vertical' }), 'role', 'tablist'), 'tablist').props[
          'aria-orientation'
        ],
      ).toBe('vertical');
    });

    test('the tablist takes a ref, which is what the roving group walks', () => {
      const list = one(withAttr(tabs(), 'role', 'tablist'), 'tablist');
      expect(() => attachRef(list, { querySelectorAll: () => [] })).not.toThrow();
    });
  });

  describe('the two message surfaces', () => {
    test('a Toast is dismissible only when both the handler and the label are given', () => {
      expect(byTag(renderNodes(Toast, { children: 'Saved' }), 'button')).toEqual([]);

      let dismissed = 0;
      const nodes = renderNodes(Toast, {
        children: 'Saved',
        title: 'Draft',
        action: 'undo',
        onDismiss: () => (dismissed += 1),
      });
      expect(one(byTag(nodes, 'p'), 'title').props['children']).toBe('Draft');

      const close = one(byTag(nodes, 'button'), 'dismiss');
      expect(close.props['aria-label']).toBe(uiString(UI_KEYS.dismiss));
      fire(close, 'onClick', {});
      expect(dismissed).toBe(1);
    });

    test('an explicit dismiss label wins over the catalog default', () => {
      const nodes = renderNodes(Toast, {
        children: 'Saved',
        dismissLabel: 'Close notification',
        onDismiss: (): void => undefined,
      });
      expect(one(byTag(nodes, 'button'), 'dismiss').props['aria-label']).toBe('Close notification');
    });

    test('Alert interrupts only for danger and warning', () => {
      const roles = (tone?: string): [unknown, unknown] => {
        const node = renderNodes(Alert, {
          children: 'body',
          ...(tone === undefined ? {} : { tone }),
        })[0];
        return [node?.props['role'], node?.props['aria-live']];
      };

      expect(roles()).toEqual(['status', 'polite']);
      expect(roles('success')).toEqual(['status', 'polite']);
      expect(roles('danger')).toEqual(['alert', 'assertive']);
      expect(roles('warning')).toEqual(['alert', 'assertive']);
    });

    test('an Alert icon is decoration; the dismiss control needs both its props', () => {
      const nodes = renderNodes(Alert, { children: 'body', icon: '!' });
      expect(one(withAttr(nodes, 'aria-hidden', 'true'), 'icon').props['children']).toBe('!');
      expect(byTag(nodes, 'button')).toEqual([]);

      let dismissed = 0;
      const dismissible = renderNodes(Alert, {
        children: 'body',
        title: 'Heads up',
        onDismiss: () => (dismissed += 1),
        dismissLabel: 'Dismiss this',
      });
      const close = one(byTag(dismissible, 'button'), 'dismiss');
      expect(close.props['aria-label']).toBe('Dismiss this');
      fire(close, 'onClick', {});
      expect(dismissed).toBe(1);

      // A handler with no label would be a nameless control.
      expect(
        byTag(renderNodes(Alert, { children: 'b', onDismiss: (): void => undefined }), 'button'),
      ).toEqual([]);
    });
  });
});
