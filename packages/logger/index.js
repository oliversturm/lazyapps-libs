import chalk from 'chalk';
import log from 'loglevel';
import prefix from 'loglevel-plugin-prefix';
import { Writable } from 'stream';

const colors = {
  TRACE: chalk.magenta,
  DEBUG: chalk.cyan,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red,
};

prefix.reg(log);
log.setLevel(process.env.LOG_LEVEL || 'info');

prefix.apply(log, {
  format: (level, name, timestamp) =>
    `${chalk.yellow(`${timestamp} [${name.slice(0, 15).padEnd(15)}]`)} ${colors[
      level.toUpperCase()
    ](level)}:`,
  timestampFormatter: function (date) {
    return date
      .toISOString()
      .replace(/.*(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}).*/, '$1 $2');
  },
});

let otelEnabled = false;
let otelLogger = null;
let otelTrace = null;
let otelContext = null;
let severityMap = {};

export const configureOtel = ({
  logs,
  SeverityNumber,
  trace,
  context,
} = {}) => {
  if (!logs || !SeverityNumber) return;
  otelLogger = logs.getLogger('@lazyapps/logger');
  otelTrace = trace || null;
  otelContext = context || null;
  severityMap = {
    trace: SeverityNumber.TRACE,
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
  };
  otelEnabled = true;
};

const emitOtelLog = (methodName, loggerName, correlationId, msg) => {
  if (!otelEnabled || !otelLogger) return;

  otelLogger.emit({
    severityNumber: severityMap[methodName],
    severityText: methodName.toUpperCase(),
    body: msg,
    attributes: {
      'logger.name': loggerName,
      'correlation.id': correlationId,
    },
  });
};

const getStream = (output) =>
  new Writable({
    write: (chunk, encoding, callback) => {
      output(chunk.toString().trim());
      callback();
    },
  });

export const getLogger = (name, correlationId) => {
  const logger = log.getLogger(name);
  const cid = correlationId || `CORR-NONE`;
  return {
    traceBare: (msg) => logger.trace(msg),
    debugBare: (msg) => logger.debug(msg),
    infoBare: (msg) => logger.info(msg),
    warnBare: (msg) => logger.warn(msg),
    errorBare: (msg) => logger.error(msg),
    logBare: (msg) => logger.log(msg),
    trace: (msg) => {
      logger.trace(`[${cid}] ${msg}`);
      emitOtelLog('trace', name, cid, msg);
    },
    debug: (msg) => {
      logger.debug(`[${cid}] ${msg}`);
      emitOtelLog('debug', name, cid, msg);
    },
    info: (msg) => {
      logger.info(`[${cid}] ${msg}`);
      emitOtelLog('info', name, cid, msg);
    },
    warn: (msg) => {
      logger.warn(`[${cid}] ${msg}`);
      emitOtelLog('warn', name, cid, msg);
    },
    error: (msg) => {
      logger.error(`[${cid}] ${msg}`);
      emitOtelLog('error', name, cid, msg);
    },
    log: (msg) => {
      logger.log(`[${cid}] ${msg}`);
      emitOtelLog('info', name, cid, msg);
    },
  };
};

export const __resetOtelForTesting = () => {
  otelEnabled = false;
  otelLogger = null;
  otelTrace = null;
  otelContext = null;
  severityMap = {};
};

export { getStream };
