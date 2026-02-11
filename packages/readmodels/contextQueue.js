import Queue from 'promise-queue';
import { context } from '@opentelemetry/api';

export const createContextQueue = (concurrency, maxQueue) => {
  const queue = new Queue(concurrency, maxQueue);

  const add = (promiseGenerator) => {
    const capturedContext = context.active();

    return queue.add(() =>
      context.with(capturedContext, () => promiseGenerator()),
    );
  };

  return { add, getQueueLength: () => queue.getQueueLength() };
};
