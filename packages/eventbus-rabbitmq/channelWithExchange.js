import amqp from 'amqplib';
import pRetry from 'p-retry';
import { redactUrl } from '@lazyapps/logger';

export const channelWithExchange = ({ url, socketOptions, exchange }, log) => {
  // amqp URLs routinely embed `guest:guest@` style credentials — redact
  // once up-front and use only the safe form anywhere near the logger.
  const safeUrl = redactUrl(url);
  return pRetry(() => amqp.connect(url, socketOptions), {
    onFailedAttempt: (error) => {
      log.error(
        `Attempt ${error.attemptNumber} failed connecting to Rabbit MQ at '${safeUrl}' for exchange '${exchange}'. Will retry another ${error.retriesLeft} times.`,
      );
    },
    retries: 10,
  })
    .then((conn) =>
      conn.createChannel().then((channel) =>
        channel
          .assertExchange(exchange, 'topic', { durable: false })
          .then(() => {
            log.info(`Event bus using Rabbit MQ exchange "${exchange}"`);
          })
          .then(() => ({ conn, channel })),
      ),
    )
    .catch((err) => {
      log.error(`Failed to connect to Rabbit MQ: ${err}`);
    });
};
