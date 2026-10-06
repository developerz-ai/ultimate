/**
 * job — `commentPosted`, from the action that enqueues it to the mail it sends, through the real
 * queue the `runJobs` fixture installs and the in-memory outbox `mail` installs. What can fail: who
 * hears about a comment (the post's author, never the commenter about their own), and that one
 * comment is one mail however many times its notification runs.
 */

import { expect, jobTest } from '@ultimat3/testing';
import { createComment } from './actions';
import { commentPosted } from './notifiers';

jobTest(
  'a comment on someone else’s post mails its author, once',
  async ({ seed, actorFor, runJobs, mail }) => {
    const { post, ada, kenji } = await seed('dev').pick({
      post: 'post:tenancy', // Ada's
      ada: 'member:ada',
      kenji: 'member:kenji',
    });

    const comment = await createComment.as(actorFor(kenji), {
      postId: post.id,
      orgId: post.orgId,
      body: 'The composite key is the part I would have forgotten.',
    });
    expect(await runJobs.depth(commentPosted)).toBe(1);
    await runJobs.drain({ actor: actorFor(kenji) });
    expect(mail.outbox().map((sent) => sent.message.to)).toEqual([[ada.email]]);

    // The same comment's notification again — an operator's retry, a second enqueue after the first
    // settled: the delivery ledger already holds it under `key`, so nothing more goes out.
    await runJobs(
      commentPosted,
      {
        params: {
          postId: post.id,
          orgId: post.orgId,
          commentId: comment.id,
          commenterId: kenji.id,
          title: post.title,
          commenter: kenji.name,
        },
      },
      { actor: actorFor(kenji) },
    );
    expect(mail.outbox()).toHaveLength(1);
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
    await runJobs.drain({ actor: actorFor(ada) });

    expect(mail.outbox()).toEqual([]);
  },
);
