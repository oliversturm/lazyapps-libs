import { env } from '$env/dynamic/private';

export const load = () => ({
  commandProcessorUrl: env.ADMIN_COMMAND_PROCESSOR_URL || '',
  readModelServices: JSON.parse(
    env.ADMIN_READ_MODEL_SERVICES || '{"default":"http://localhost:3002"}',
  ),
});
