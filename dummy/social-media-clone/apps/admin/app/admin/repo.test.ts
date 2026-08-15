// The dashboard's ids arrive from a URL, so the repo is where an id stops being a `string`. These
// pin that it is a PARSE and not a cast: `/admin/users/nope` is refused here, with the column's own
// error, instead of reaching the driver as a lookup that quietly matches no row.

import { beforeAll, expect, test } from 'bun:test';
import { seedDemo } from '@social-media-clone/db';
import { usersAdminRepo } from './repo';

beforeAll(async () => {
  await seedDemo();
});

test('an id the primary key column rejects never reaches the driver', async () => {
  await expect(usersAdminRepo.find('not-a-uuid')).rejects.toThrow(/expected a uuid/);
  await expect(usersAdminRepo.destroy('not-a-uuid')).rejects.toThrow(/expected a uuid/);
  await expect(usersAdminRepo.update('not-a-uuid', { bio: 'x' })).rejects.toThrow(
    /expected a uuid/,
  );
});

test('a well-formed id still reads the row it names', async () => {
  const [user] = await usersAdminRepo.list({
    limit: 1,
    sort: { field: 'handle', direction: 'asc' },
  });
  expect(user).toBeDefined();
  const found = await usersAdminRepo.find(String(user?.id));
  expect(found?.handle).toBe(String(user?.handle));
});
