import { describe, expect, test } from 'bun:test';
import { pageComponentOf } from './route-component';

const Page = (): string => 'page';
const HomePage = (): string => 'home';
const AdminHome = (): string => 'admin';
const LikeButton = (): string => 'like';

describe('pageComponentOf', () => {
  test('a module with no capitalised function has no page', () => {
    expect(pageComponentOf({ config: {}, appName: 'x', helper: () => 1 })).toBeUndefined();
  });

  test('`Page` wins outright', () => {
    expect(pageComponentOf({ HomePage, Page })).toBe(Page);
  });

  test('a single `…Page` is the page when there is no `Page`', () => {
    expect(pageComponentOf({ config: {}, HomePage, appName: 'x' })).toBe(HomePage);
  });

  test('a single capitalised function is the page even without the suffix', () => {
    expect(pageComponentOf({ config: {}, AdminHome })).toBe(AdminHome);
  });

  test('two `…Page` exports fall through to a deterministic pick, never a coin toss', () => {
    const module = { HomePage, ListPage: LikeButton };
    expect(pageComponentOf(module)).toBe(pageComponentOf({ ...module }));
    expect(pageComponentOf(module)).toBe(HomePage);
  });

  test('the fallback is sorted, so export order cannot change the answer', () => {
    expect(pageComponentOf({ AdminHome, LikeButton })).toBe(AdminHome);
    expect(pageComponentOf({ LikeButton, AdminHome })).toBe(AdminHome);
  });
});
