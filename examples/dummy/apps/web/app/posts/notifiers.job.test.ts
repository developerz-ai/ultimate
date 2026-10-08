/**
 * job — `commentPosted`, from the action that enqueues it to the mail and the push it sends, through
 * the real queue the `runJobs` fixture installs, the in-memory outbox `mail` installs and the push
 * service and device `push` plays. What can fail: who
 * hears about a comment (the post's author, never the commenter about their own), and that one
 * comment is one mail however many times its notification runs.
 */

import { expect, jobTest } from '@ultimat3/testing';
import { createComment } from './actions';
import { commentPosted } from './notifiers';

jobTest(
  'a comment on someone else’s post mails its author and pushes to her browser, once',
  async ({ seed, actorFor, runJobs, mail, push }) => {
    const { post, ada, kenji } = await seed('dev').pick({
      post: 'post:tenancy', // Ada's
      ada: 'member:ada',
      kenji: 'member:kenji',
    });
    // Ada subscribed one browser, in Spanish: the push renders in the locale it subscribed in.
    await push.subscribe(ada.id, { locale: 'es' });

    const comment = await createComment.as(actorFor(kenji), {
      postId: post.id,
      orgId: post.orgId,
      body: 'The composite key is the part I would have forgotten.',
    });
    expect(await runJobs.depth(commentPosted)).toBe(1);
    // No `actor`: the production worker is nobody (`role-start.ts`).
    await runJobs.drain();
    expect(mail.outbox().map((sent) => sent.message.to)).toEqual([[ada.email]]);
    // What her device shows: rendered from catalog keys, tagged by post, linking to it.
    expect(push.sent().map((sent) => sent.notification)).toEqual([
      expect.objectContaining({
        title: `${kenji.name} comentó en ${post.title}`,
        url: `/posts/${post.id}`,
        tag: `post:${post.id}`,
        lang: 'es',
      }),
    ]);

    // The same comment's notification again — an operator's retry, a second enqueue after the first
    // settled: the delivery ledger already holds it under `key`, so nothing more goes out.
    await runJobs(commentPosted, {
      params: {
        postId: post.id,
        orgId: post.orgId,
        commentId: comment.id,
        commenterId: kenji.id,
        title: post.title,
        commenter: kenji.name,
      },
    });
    expect(mail.outbox()).toHaveLength(1);
    expect(push.sent()).toHaveLength(1);
  },
);

jobTest(
  'an author commenting on their own post is told nothing',
  async ({ seed, actorFor, runJobs, mail }) => {
    const { post, ada } = await seed('dev').pick({ post: 'post:tenancy', ada: 'member:ada' });

    await createComment.as(actorFor(ada), {
      postId: post.id,
      orgId: post.orgId,
      body: 'Adding the migration note.',
    });
    await runJobs.drain();

    expect(mail.outbox()).toEqual([]);
  },
);
