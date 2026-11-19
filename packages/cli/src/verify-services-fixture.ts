// TEST-ONLY. One line of `docker compose ps --all --format json`, as compose prints it for a
// container this checkout's compose file started.

import { TEST_COMPOSE_PATH } from './templates/scaffold-test-services';

export const psLine = (project: string, service: string, root: string, state = 'running'): string =>
  JSON.stringify({
    Project: project,
    Service: service,
    State: state,
    Labels: [
      'org.opencontainers.image.title=A Server',
      `com.docker.compose.project=${project}`,
      `com.docker.compose.project.config_files=${root}/${TEST_COMPOSE_PATH}`,
      `com.docker.compose.project.working_dir=${root}/docker`,
      `com.docker.compose.service=${service}`,
    ].join(','),
  });
