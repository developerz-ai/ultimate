// Single responsibility: the welcome mail, as data. Keys only — the words live in a catalog.

import { type Infer, t } from '@ultimat3/schema';
import { blocks } from '../blocks';
import { defineMail } from '../mail';

export const welcomeInput = t.object({
  name: t.string,
  appName: t.string,
  url: t.url,
});

export type WelcomeInput = Infer<typeof welcomeInput>;

export const welcomeMail = defineMail<WelcomeInput>({
  id: 'welcome',
  subject: 'mail.welcome.subject',
  input: welcomeInput,
  template: ({ data }) => [
    blocks.heading('mail.welcome.heading', { name: data.name }),
    blocks.paragraph('mail.welcome.body', { appName: data.appName }),
    blocks.button('mail.welcome.cta', data.url, { appName: data.appName }),
  ],
});
