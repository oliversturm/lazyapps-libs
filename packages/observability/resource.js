import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export const createResource = (config) => {
  const attrs = {};
  if (config.serviceName) attrs[ATTR_SERVICE_NAME] = config.serviceName;
  if (config.serviceNamespace)
    attrs['service.namespace'] = config.serviceNamespace;
  if (config.serviceVersion)
    attrs[ATTR_SERVICE_VERSION] = config.serviceVersion;
  if (config.environment)
    attrs['deployment.environment.name'] = config.environment;
  return Object.keys(attrs).length > 0
    ? resourceFromAttributes(attrs)
    : undefined;
};
