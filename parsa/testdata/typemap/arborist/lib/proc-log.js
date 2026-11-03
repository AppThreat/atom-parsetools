// Local no-op stub for proc-log.  The real package drives npm's progress
// bars and structured logging; cdxgen's vendored arborist is read-only and
// silent, so every method is a no-op.  If a future arborist version starts
// relying on proc-log return values rather than side effects, widen this stub.

const noop = () => {};
const noopReturn = (v) => () => v;

const log = {
  silly: noop,
  verbose: noop,
  info: noop,
  timing: noop,
  http: noop,
  notice: noop,
  warn: noop,
  error: noop,
  pause: noop,
  resume: noop,
};

// proc-log's time.start(name) returns an end function that the caller invokes
// when the timed section is done.  Return noop so the call site works.
const time = {
  start: noopReturn(noop),
  end: noop,
  emit: noop,
};

export { log, time };
