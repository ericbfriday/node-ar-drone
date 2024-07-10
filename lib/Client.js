var EventEmitter = require('events').EventEmitter;
var util         = require('util');

Client.UdpControl       = require('./control/UdpControl');
Client.Repl             = require('./Repl');
Client.UdpNavdataStream = require('./navdata/UdpNavdataStream');
Client.PngStream        = require('./video/PngStream');
Client.PngEncoder       = require('./video/PngEncoder');
Client.TcpVideoStream   = require('./video/TcpVideoStream');

module.exports = Client;
util.inherits(Client, EventEmitter);
class Client {
  constructor(options) {
    EventEmitter.call(this);

    options = options || {};

    this._options = options;
    this._udpControl = options.udpControl || new Client.UdpControl(options);
    this._udpNavdatasStream = options.udpNavdataStream || new Client.UdpNavdataStream(options);
    this._pngStream = null;
    this._tcpVideoStream = null;
    this._interval = null;
    this._ref = {};
    this._pcmd = {};
    this._repeaters = [];
    this._afterOffset = 0;
    this._disableEmergency = false;
    this._lastState = 'CTRL_LANDED';
    this._lastBattery = 100;
    this._lastAltitude = 0;
  }
  after(duration, fn) {
    setTimeout(fn.bind(this), this._afterOffset + duration);
    this._afterOffset += duration;
    return this;
  }
  createRepl() {
    var repl = new Client.Repl(this);
    repl.resume();
    return repl;
  }
  createPngStream() {
    console.warn("Client.createPngStream is deprecated. Use Client.getPngStream instead.");
    return this.getPngStream();
  }
  getPngStream() {
    if (this._pngStream === null) {
      this._pngStream = this._newPngStream();
    }
    return this._pngStream;
  }
  getVideoStream() {
    if (!this._tcpVideoStream) {
      this._tcpVideoStream = this._newTcpVideoStream();
    }
    return this._tcpVideoStream;
  }
  _newTcpVideoStream() {
    var stream = new Client.TcpVideoStream(this._options);
    var callback = function (err) {
      if (err) {
        console.log('TcpVideoStream error: %s', err.message);
        setTimeout(function () {
          console.log('Attempting to reconnect to TcpVideoStream...');
          stream.connect(callback);
        }, 1000);
      }
    };

    stream.connect(callback);
    stream.on('error', callback);
    return stream;
  }
  _newPngStream() {
    var videoStream = this.getVideoStream();
    var pngEncoder = new Client.PngEncoder(this._options);

    videoStream.on('data', function (data) {
      pngEncoder.write(data);
    });

    return pngEncoder;
  }
  resume() {
    // Reset config ACK.
    this._udpControl.ctrl(5, 0);
    // request basic navdata by default
    this.config('general:navdata_demo', 'TRUE');
    this.disableEmergency();
    this._setInterval(30);

    this._udpNavdatasStream.removeAllListeners();
    this._udpNavdatasStream.resume();
    this._udpNavdatasStream
      .on('error', this._maybeEmitError.bind(this))
      .on('data', this._handleNavdata.bind(this));
  }
  _handleNavdata(navdata) {
    if (navdata.droneState && navdata.droneState.emergencyLanding && this._disableEmergency) {
      this._ref.emergency = true;
    } else {
      this._ref.emergency = false;
      this._disableEmergency = false;
    }
    if (navdata.droneState.controlCommandAck) {
      this._udpControl.ack();
    } else {
      this._udpControl.ackReset();
    }
    this.emit('navdata', navdata);
    this._processNavdata(navdata);
  }
  _processNavdata(navdata) {
    if (navdata.droneState && navdata.demo) {
      // controlState events
      var cstate = navdata.demo.controlState;
      var emitState = (function (e, state) {
        if (cstate === state && this._lastState !== state) {
          return this.emit(e);
        }
      }).bind(this);
      emitState('landing', 'CTRL_TRANS_LANDING');
      emitState('landed', 'CTRL_LANDED');
      emitState('takeoff', 'CTRL_TRANS_TAKEOFF');
      emitState('hovering', 'CTRL_HOVERING');
      emitState('flying', 'CTRL_FLYING');
      this._lastState = cstate;

      // battery events
      var battery = navdata.demo.batteryPercentage;
      if (navdata.droneState.lowBattery === 1) {
        this.emit('lowBattery', battery);
      }
      if (navdata.demo.batteryPercentage !== this._lastBattery) {
        this.emit('batteryChange', battery);
        this._lastBattery = battery;
      }

      // altitude events
      var altitude = navdata.demo.altitudeMeters;
      if (altitude !== this._lastAltitude) {
        this.emit('altitudeChange', altitude);
        this._lastAltitude = altitude;
      }
    }

  }
  // emits an 'error' event, but only if somebody is listening. This avoids
  // making node's EventEmitter throwing an exception for non-critical errors
  _maybeEmitError(err) {
    if (this.listeners('error').length > 0) {
      this.emit('error', err);
    }
  }
  _setInterval(duration) {
    clearInterval(this._interval);
    this._interval = setInterval(this._sendCommands.bind(this), duration);
  }
  _sendCommands() {
    this._udpControl.ref(this._ref);
    this._udpControl.pcmd(this._pcmd);
    this._udpControl.flush();

    this._repeaters
      .forEach(function (repeat) {
        repeat.times--;
        repeat.method();
      });

    this._repeaters = this._repeaters.filter(function (repeat) {
      return repeat.times > 0;
    });
  }
  disableEmergency() {
    this._disableEmergency = true;
  }
  takeoff(cb) {
    this.once('hovering', cb || function () { });
    this._ref.fly = true;
    return true;
  }
  land(cb) {
    this.once('landed', cb || function () { });
    this._ref.fly = false;
    return true;
  }
  stop() {
    this._pcmd = {};
    return true;
  }
  calibrate(device) {
    switch (device) { // allow for sub classing
      case 0: // Calibrate magnometer.. 
        this._udpControl.calibrate(device); // essentially call the magnometer
        break;
      case 1: //Set FTRIM

        // @TODO Figure out if we can get a ACK for this, so we don't need to
        // repeat it blindly like this
        if (this._ref.fly) {
          console.trace("You can’t ftrim when you fly");
          return false;
        }

        var self = this;
        this._repeat(10, function () {
          self._udpControl.ftrim();
        });
        break;

      default: //error handling, feel free to add any error messages here <3
    }
  }
  config(key, value, callback) {
    this._udpControl.config(key, value, callback);
  }
  ctrl(controlMode, otherMode) {
    this._udpControl.ctrl(controlMode, otherMode);
  }
  animate(animation, duration) {
    // @TODO Figure out if we can get a ACK for this, so we don't need to
    // repeat it blindly like this
    var self = this;
    this._repeat(10, function () {
      self._udpControl.animate(animation, duration);
    });
  }
  animateLeds(animation, hz, duration) {
    // @TODO Figure out if we can get a ACK for this, so we don't need to
    // repeat it blindly like this
    var self = this;
    this._repeat(10, function () {
      self._udpControl.animateLeds(animation, hz, duration);
    });
  }
  battery() {
    return this._lastBattery;
  }
  _repeat(times, fn) {
    this._repeaters.push({ times: times, method: fn });
  }
}

























var pcmdOptions = [
  ['up', 'down'],
  ['left', 'right'],
  ['front', 'back'],
  ['clockwise', 'counterClockwise'],
];

pcmdOptions.forEach(function(pair) {
  Client.prototype[pair[0]] = function(speed) {
    if (isNaN(speed)) {
      return;
    }
    speed = parseFloat(speed);

    this._pcmd[pair[0]] = speed;
    delete this._pcmd[pair[1]];

    return speed;
  };

  Client.prototype[pair[1]] = function(speed) {
    if (isNaN(speed)) {
      return;
    }

    speed = parseFloat(speed);

    this._pcmd[pair[1]] = speed;
    delete this._pcmd[pair[0]];

    return speed;
  };
});
