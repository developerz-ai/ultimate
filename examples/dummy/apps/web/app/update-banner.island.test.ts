/**
 * unit — the banner answers the worker only about a build this document is NOT running.
 *
 * The worker posts `AppUpdateAvailable` to every page it controls on activation, including a page
 * that was rendered by the very build it announces; a banner that took every message at its word
 * would offer a reload that changes nothing.
 */

import { APP_UPDATE_MESSAGE as APP_UPDATE_AVAILABLE } from '@ultimat3/core';
import { expect, test } from '@ultimat3/testing';
import { announcedBuild } from './update-banner.island';

test('a build this document is not running is announced', () => {
  expect(announcedBuild({ type: APP_UPDATE_AVAILABLE, to: 'build-2' }, 'build-1')).toBe('build-2');
});

test('the build this document already runs is not news', () => {
  expect(announcedBuild({ type: APP_UPDATE_AVAILABLE, to: 'build-1' }, 'build-1')).toBeNull();
});

test('any other message the worker posts is not an update', () => {
  expect(announcedBuild({ type: 'x-outbox-drain' }, 'build-1')).toBeNull();
  expect(announcedBuild({ type: APP_UPDATE_AVAILABLE }, 'build-1')).toBeNull();
  expect(announcedBuild('AppUpdateAvailable', 'build-1')).toBeNull();
  expect(announcedBuild(null, 'build-1')).toBeNull();
});
