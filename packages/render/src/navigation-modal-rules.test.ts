// The route-presented modal's pure rules: the hash grammar never throws and never leaves the
// origin, a hash-addressed modal degrades instead of following or loading, a POST re-renders a
// modal only from inside one, and leaving a modal never strands its entry on the history.
import { describe, expect, test } from 'bun:test';
import {
  addressOf,
  leaveModal,
  modalAddress,
  modalHistory,
  modalLocation,
  type PresentationFacts,
  presentation,
} from './navigation-modal-rules';

const BASE = 'https://app.test/runs';

describe('modalAddress', () => {
  test.each([
    ['#/runs/new', '/runs/new'],
    ['#/test-accounts/abc/edit/credentials', '/test-accounts/abc/edit/credentials'],
    ['#/runs/new?bank=ve&x=1', '/runs/new?bank=ve&x=1'],
    ['#/a/b#c', '/a/b'],
    ['#/a/../b', '/b'],
  ])('%p addresses %p', (hash, address) => {
    expect(modalAddress(hash, BASE)).toBe(address);
  });

  test.each([[''], ['#'], ['#below'], ['#//evil.test/x'], ['#/\\evil.test'], ['#runs/new']])(
    '%p addresses no modal',
    (hash) => {
      expect(modalAddress(hash, BASE)).toBeNull();
    },
  );

  test('a base that does not parse is no modal, never a throw', () => {
    expect(modalAddress('#/runs/new', 'not a url')).toBeNull();
  });

  test('round trip: the location a modal is shown at addresses that modal', () => {
    const at = modalLocation('https://app.test/runs?page=2#below', '/runs/new?x=1');
    expect(at).toBe('https://app.test/runs?page=2#/runs/new?x=1');
    expect(modalAddress(new URL(at).hash, at)).toBe('/runs/new?x=1');
    expect(addressOf('https://app.test/runs/new?x=1#f')).toBe('/runs/new?x=1');
  });
});

const facts = (patch: Partial<PresentationFacts> = {}): PresentationFacts => ({
  fromHash: false,
  method: 'GET',
  verdict: 'swap',
  status: 200,
  modalPage: true,
  modalOpen: false,
  landed: 'https://app.test/runs/new',
  rendered: 'https://app.test/runs',
  movesTab: false,
  ...patch,
});

describe('presentation', () => {
  test('a click onto a modal page opens it over the page on screen', () => {
    expect(presentation(facts())).toBe('modal');
  });

  test('a page that is not a modal is the router’s ordinary page', () => {
    expect(presentation(facts({ modalPage: false }))).toBe('page');
    expect(presentation(facts({ verdict: 'follow' }))).toBe('page');
    expect(presentation(facts({ verdict: 'load' }))).toBe('page');
  });

  test('a link to the page on screen is that page, even when it is a modal route', () => {
    expect(presentation(facts({ landed: 'https://app.test/runs' }))).toBe('page');
  });

  test('a POST re-renders the modal only from inside one', () => {
    expect(presentation(facts({ method: 'POST', status: 422, modalOpen: true }))).toBe('modal');
    expect(presentation(facts({ method: 'POST', status: 422, modalOpen: false }))).toBe('page');
  });

  test('an answer for another principal or build is never shown in a modal', () => {
    expect(presentation(facts({ method: 'POST', modalOpen: true, movesTab: true }))).toBe('page');
  });

  test('from the hash: only a 2xx modal page opens; everything else degrades', () => {
    expect(presentation(facts({ fromHash: true }))).toBe('modal');
    for (const patch of [
      { modalPage: false },
      { status: 404 },
      { status: 500 },
      { verdict: 'follow' as const },
      { verdict: 'load' as const },
      { verdict: 'stay' as const },
      { verdict: 'hand-over' as const },
      { movesTab: true },
    ]) {
      expect(presentation(facts({ fromHash: true, ...patch }))).toBe('degrade');
    }
  });
});

describe('history', () => {
  test('a modal shown by a click pushes; a POST replaces; Back/Forward moves nothing', () => {
    expect(modalHistory('GET', undefined)).toBe('push');
    expect(modalHistory('GET', 'push')).toBe('push');
    expect(modalHistory('POST', undefined)).toBe('replace');
    expect(modalHistory('GET', 'none')).toBe('none');
    expect(modalHistory('POST', 'none')).toBe('none');
  });

  test('leaving onto the page beneath goes Back through an entry this router pushed', () => {
    const page = 'https://app.test/runs';
    const leave = (patch: Partial<Parameters<typeof leaveModal>[0]>) =>
      leaveModal({ history: 'push', landed: page, rendered: page, owned: true, ...patch });
    expect(leave({})).toBe('back');
    // A cold-loaded `/runs#/runs/new`: nothing of ours beneath — Back would leave the app.
    expect(leave({ owned: false })).toBe('replace');
    expect(leave({ landed: 'https://app.test/runs/7' })).toBe('replace');
    expect(leave({ history: 'none' })).toBe('none');
  });
});
