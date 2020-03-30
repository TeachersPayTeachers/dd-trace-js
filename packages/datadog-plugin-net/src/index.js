'use strict'

const tx = require('../../dd-trace/src/plugins/util/tx')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const noopCallback = function() {}

function createWrapConnect (tracer, config) {
  return function wrapConnect (connect) {
    return function connectWithTrace () {
      const scope = tracer.scope()
      const options = getConnectOptions(arguments)

      if (!options) return connect.apply(this, arguments)

      const span = options.path
        ? wrapIpc(tracer, config, this, 'connect', options, setupConnectListeners)
        : wrapTcp(tracer, config, this, 'connect', options, setupConnectListeners)

      analyticsSampler.sample(span, config.analytics)

      return scope.bind(connect, span).apply(this, arguments)
    }
  }
}

function createWrapWrite (tracer, config) {
  return function wrapWrite (write) {
    return function writeWithTrace () {
      const scope = tracer.scope()

      // Not clear how to check if socket is IPC, so just assume TCP.
      const span = wrapTcp(tracer, config, this, 'write', {
        host: this.remoteAddress,
        port: this.remotePort,
        family: this.remoteFamily
      }, () => {})

      const wrappedArgs = wrapWriteArgs(span, arguments)

      analyticsSampler.sample(span, config.analytics)

      return scope.bind(write, span).apply(this, wrappedArgs)
    }
  }
}

function wrapTcp (tracer, config, socket, op, options, setupListeners) {
  const host = options.host || 'localhost'
  const port = options.port || 0
  const family = options.family || 4

  const span = startSpan(tracer, config, 'tcp', op, {
    'resource.name': [host, port].filter(val => val).join(':'),
    'tcp.remote.host': host,
    'tcp.remote.port': port,
    'tcp.family': `IPv${family}`,
    'out.host': host,
    'out.port': port
  })

  setupListeners(socket, span, 'tcp')

  return span
}

function wrapIpc (tracer, config, socket, op, options, setupListeners) {
  const span = startSpan(tracer, config, 'ipc', op, {
    'resource.name': options.path,
    'ipc.path': options.path
  })

  setupListeners(socket, span, 'ipc')

  return span
}

function startSpan (tracer, config, protocol, op, tags) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan(`${protocol}.${op}`, {
    childOf,
    tags: Object.assign({
      'span.kind': 'client',
      'service.name': config.service || `${tracer._service}-${protocol}`
    }, tags)
  })

  return span
}

function getConnectOptions (args) {
  if (!args[0]) return

  switch (typeof args[0]) {
    case 'object':
      if (Array.isArray(args[0])) return getConnectOptions(args[0])
      return args[0]
    case 'string':
      if (isNaN(parseFloat(args[0]))) {
        return {
          path: args[0]
        }
      }
    case 'number': // eslint-disable-line no-fallthrough
      return {
        port: args[0],
        host: typeof args[1] === 'string' ? args[1] : 'localhost'
      }
  }
}

function setupConnectListeners (socket, span, protocol) {
  const events = ['connect', 'error', 'close', 'timeout']

  const wrapListener = tx.wrap(span)

  const localListener = () => {
    span.addTags({
      'tcp.local.address': socket.localAddress,
      'tcp.local.port': socket.localPort
    })
  }

  const cleanupListener = () => {
    socket.removeListener('connect', localListener)

    events.forEach(event => {
      socket.removeListener(event, wrapListener)
      socket.removeListener(event, cleanupListener)
    })
  }

  if (protocol === 'tcp') {
    socket.once('connect', localListener)
  }

  events.forEach(event => {
    socket.once(event, wrapListener)
    socket.once(event, cleanupListener)
  })
}

function wrapWriteArgs (span, args) {
  let wrappedArgs = args;

  if(typeof wrappedArgs[wrappedArgs.length - 1] != 'function') {
    wrappedArgs = Array.prototype.slice.call(args);
    wrappedArgs.push(noopCallback);
  }

  const originalCallback = wrappedArgs[wrappedArgs.length - 1]
  const wrappedCallback = tx.wrap(span, originalCallback)

  wrappedArgs[wrappedArgs.length - 1] = wrappedCallback

  return wrappedArgs;
}

module.exports = {
  name: 'net',
  patch (net, tracer, config) {
    require('dns') // net will otherwise get an unpatched version for DNS lookups

    tracer.scope().bind(net.Socket.prototype)

    this.wrap(net.Socket.prototype, 'connect', createWrapConnect(tracer, config))
    this.wrap(net.Socket.prototype, 'write', createWrapWrite(tracer, config))
  },
  unpatch (net, tracer) {
    tracer.scope().unbind(net.Socket.prototype)

    this.unwrap(net.Socket.prototype, ['connect', 'write'])
  }
}
