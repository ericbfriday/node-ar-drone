var Stream       = require('stream').Stream;
var util         = require('util');
var dgram        = require('dgram');
var constants    = require('../constants');
var parseNavdata = require('./parseNavdata');

module.exports = UdpNavdataStream;
util.inherits(UdpNavdataStream, Stream);
class UdpNavdataStream {
  constructor(options) {
    Stream.call(this);

    options = options || {};

    this.readable = true;
    this._socket = options.socket || dgram.createSocket('udp4');
    this._port = options.port || constants.ports.NAVDATA;
    this._ip = options.ip || constants.DEFAULT_DRONE_IP;
    this._initialized = false;
    this._parseNavdata = options.parser || parseNavdata;
    this._timeout = options.timeout || 100;
    this._timer = undefined;
    this._sequenceNumber = 0;
  }
  resume() {
    if (!this._initialized) {
      this._init();
      this._initialized = true;
    }

    this._requestNavdata();
  }
  destroy() {
    this._socket.close();
  }
  _init() {
    this._socket.bind();
    this._socket.on('message', this._handleMessage.bind(this));
  }
  _requestNavdata() {
    var buffer = new Buffer([1]);
    this._socket.send(buffer, 0, buffer.length, this._port, this._ip);

    this._setTimeout();

    // @TODO logging
  }
  _setTimeout() {
    clearTimeout(this._timer);
    this._timer = setTimeout(this._requestNavdata.bind(this), this._timeout);
  }
  _handleMessage(buffer) {
    var navdata = {};

    try {
      navdata = this._parseNavdata(buffer);
    } catch (err) {
      // avoid 'error' causing an exception when nobody is listening
      if (this.listeners('error').length > 0) {
        this.emit('error', err);
      }
      return;
    }

    // Ignore out of order messages
    if (navdata.sequenceNumber > this._sequenceNumber) {
      this._sequenceNumber = navdata.sequenceNumber;
      this.emit('data', navdata);
    }

    this._setTimeout();
  }
}






