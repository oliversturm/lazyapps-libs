import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export const createResource = (config) =>
  resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.serviceVersion && {
      [ATTR_SERVICE_VERSION]: config.serviceVersion,
    }),
    ...(config.environment && {
      'deployment.environment.name': config.environment,
    }),
  });
