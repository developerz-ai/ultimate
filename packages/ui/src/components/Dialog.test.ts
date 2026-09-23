// The backdrop dismiss. A click whose target is the <dialog> itself is a backdrop click — but a
// drag-select STARTED inside the panel and released over the backdrop fires a click there too, and
// closed the dialog under a user who was only selecting text. Both halves must land on the backdrop.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attachRef, byTag, fire, one, probe, renderNodes, unprobe } from '../jsx-probe';
import { Dialog } from './Dialog';

describe('Dialog backdrop dismiss', () => {
  beforeAll(probe);
  afterAll(unprobe);

  const setup = () => {
    let closed = 0;
    const nodes = renderNodes(Dialog, {
      open: false,
      title: 'Edit',
      onClose: () => {
        closed += 1;
      },
      children: null,
    });
    const dialog = one(byTag(nodes, 'dialog'), '<dialog>');
    const element = { open: false, showModal() {}, close() {} };
    attachRef(dialog, element);
    return { dialog, element, closed: () => closed };
  };

  test('a press and a release both on the backdrop close it', () => {
    const { dialog, element, closed } = setup();
    fire(dialog, 'onPointerDown', { target: element });
    fire(dialog, 'onClick', { target: element });
    expect(closed()).toBe(1);
  });

  test('a drag that starts inside the panel and ends on the backdrop does not', () => {
    const { dialog, element, closed } = setup();
    fire(dialog, 'onPointerDown', { target: { inside: true } });
    fire(dialog, 'onClick', { target: element });
    expect(closed()).toBe(0);
  });

  test('dismissOnBackdrop: false keeps it open whatever the pointer did', () => {
    let closed = 0;
    const nodes = renderNodes(Dialog, {
      open: false,
      title: 'Edit',
      dismissOnBackdrop: false,
      onClose: () => {
        closed += 1;
      },
      children: null,
    });
    const dialog = one(byTag(nodes, 'dialog'), '<dialog>');
    const element = { open: false, showModal() {}, close() {} };
    attachRef(dialog, element);
    fire(dialog, 'onPointerDown', { target: element });
    fire(dialog, 'onClick', { target: element });
    expect(closed).toBe(0);
  });
});
