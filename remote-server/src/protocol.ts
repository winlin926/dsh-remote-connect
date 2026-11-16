/**
 * Re-export of the shared remote protocol. The Host, the browser client and
 * this relay speak exactly the same control-frame format; keeping the single
 * import here means the relative specifier to the repository's vendored
 * protocol exists in exactly one place.
 */
export * from '../../src/remote/vendor/protocol/index.js'
