// The one source of a scaffolded app's Dependabot-maintained image pins: ./pinned/docker-compose.yml.

import pinned from './pinned/docker-compose.yml' with { type: 'yaml' };

const { services } = pinned as { services: { s3: { image: string } } };

/** The S3 gateway every scaffolded compose file runs. */
export const S3_GATEWAY_IMAGE = services.s3.image;
