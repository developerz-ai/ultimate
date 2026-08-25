// The whole chain, in one file: a server rejection → an issue path → `Field`'s error slot → the
// `aria-invalid` and `aria-describedby` a screen reader announces. The pure rules are proven
// beside their own modules; this is the WIRING, which is the half that has shipped broken here
// before — a correct helper called with the wrong argument passes every assertion about itself.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Field, type FieldControl } from '../components/Field';
import { Form } from '../components/Form';
import { one, type ProbeNode, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import type { FormIssue } from './form-issue';
import { useForm } from './use-form';

/** The app's wording, keyed on the path — one `t()` call in a real app. */
const label = (found: FormIssue): string => `«${found.path}»`;

const rejected = async (
  cause: string,
): Promise<ReturnType<typeof useForm<{ title: string }, { id: string }>>> => {
  const form = useForm<{ title: string }, { id: string }>({
    fields: ['title'],
    messageFor: label,
    submit: () => Promise.reject({ code: 'X_INPUT_INVALID', cause }),
  });
  await form.submit({ title: '' });
  return form;
};

const fieldNodes = (error: string | undefined, into: { control?: FieldControl }): ProbeNode[] =>
  renderNodes(Field, {
    label: 'Title',
    error,
    children: (control: FieldControl) => {
      into.control = control;
      return null;
    },
  });

describe('an action’s rejection reaching the control that caused it', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the components under test compile to a JSX factory this file understands', () => {
    expect(fieldNodes(undefined, {}).length).toBeGreaterThan(0);
  });

  test('marks the named control invalid and points it at the message', async () => {
    const form = await rejected('title: too short');
    const held: { control?: FieldControl } = {};
    const nodes = fieldNodes(form.errorFor('title'), held);

    const message = one(withAttr(nodes, 'role', 'alert'), 'error message');
    expect(message.props['children']).toBe('«title»');
    expect(held.control?.['aria-invalid']).toBe(true);
    // The id is Field's own and internal; the only thing that makes it reachable is this equality.
    // Asserted as a string first: `props` is an unknown-valued bag, so an `undefined === undefined`
    // comparison would pass here while the control pointed at nothing.
    const describedBy = message.props['id'];
    expect(typeof describedBy).toBe('string');
    expect(held.control?.['aria-describedby']).toBe(describedBy as string);
  });

  test('leaves a control no issue named valid and undescribed', async () => {
    const form = await rejected('slug: already taken');
    const held: { control?: FieldControl } = {};
    const nodes = fieldNodes(form.errorFor('title'), held);

    expect(withAttr(nodes, 'role', 'alert')).toHaveLength(0);
    expect(held.control?.['aria-invalid']).toBe(false);
    expect(held.control?.['aria-describedby']).toBeUndefined();
  });

  test('and that issue is not lost — it takes the form summary, which takes focus', async () => {
    const form = await rejected('slug: already taken');
    expect(form.state().formErrors).toEqual(['«slug»']);

    const nodes = renderNodes(Form, { children: null, error: form.state().formErrors[0] });
    const summary = one(withAttr(nodes, 'tabindex', '-1'), 'tabindex="-1" element');
    expect(typeof summary.props['ref']).toBe('function');
  });
});
