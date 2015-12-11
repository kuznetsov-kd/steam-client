var ByteBuffer = require('bytebuffer');
var Steam = module.exports = require('steam-resources');
var SteamCrypto = require('steam-crypto');
var BufferCRC32 = require('buffer-crc32');
var Zip = require('adm-zip');

var TCPConnection = require('./tcp_connection.js');

var Schema = Steam.Internal;

Steam._processProto = function(proto) {
	proto = proto.toRaw(false, true);
	(function deleteNulls(proto) {
		for (var field in proto) {
			if (!proto.hasOwnProperty(field)) {
				continue;
			}

			if (proto[field] == null) {
				delete proto[field];
			} else if (typeof proto[field] == 'object') {
				deleteNulls(proto[field]);
			}
		}
	})(proto);
	return proto;
};

/**
 * Protocols we can use to connect to a Steam CM. Currently only TCP is supported.
 * @enum EConnectionProtocol
 */
Steam.EConnectionProtocol = {
	"TCP": 1
};

var EMsg = Steam.EMsg;

const PROTO_MASK = 0x80000000;

require('util').inherits(CMClient, require('events').EventEmitter);

/**
 * Create a new Steam Client
 * @param {EConnectionProtocol} [protocol=TCP] - The protocol with which we want to connect
 * @augments EventEmitter
 * @constructor
 */
function CMClient(protocol) {
	this.protocol = protocol || Steam.EConnectionProtocol.TCP;
}

/**
 * Change the local IP/port that will be used to connect (takes effect on next connection)
 * @param {string} [localAddress] - The local IP address (in string format) that will be used to connect
 * @param {int} [localPort] - The local port that will be used to connect
 */
CMClient.prototype.bind = function(localAddress, localPort) {
	this.localAddress = localAddress;
	this.localPort = localPort;
};


// Methods

Steam.servers = require('./servers');

/**
 * Connect to Steam.
 * @param {object} [server] - The CM server to which we will connect. If omitted, chosen randomly.
 * @param {string} [server.host] - The IP address or hostname of the server to which we would like to connect
 * @param {int} [server.port] - The port of the server to which we would like to connect
 * @param {boolean} [autoRetry=true] - Should we automatically attempt to reconnect if we can't establish a connection?
 */
CMClient.prototype.connect = function(server, autoRetry) {
	this.disconnect();

	this._jobs = {};
	this._currentJobID = 0;

	this._sessionID = 0;

	this._server = server;
	this._autoRetry = autoRetry;

	server = server || Steam.servers[Math.floor(Math.random() * Steam.servers.length)];
	this.emit('debug', 'connecting to ' + server.host + ':' + server.port);

	switch (this.protocol) {
		case Steam.EConnectionProtocol.TCP:
			this._connection = new TCPConnection();
			break;

		default:
			throw new Error("Unknown connection protocol");
	}

	this._connection.on('packet', this._netMsgReceived.bind(this));
	this._connection.on('close', this._disconnected.bind(this));

	var self = this;

	this._connection.on('error', function(err) {
		// it's ok, we'll reconnect after 'close'
		self.emit('debug', 'socket error: ' + err);
	});

	this._connection.on('connect', function() {
		self.emit('debug', 'connected');
		delete self._timeout;
	});

	this._connection.on('end', function() {
		self.emit('debug', 'socket ended');
	});

	this._connection.setTimeout(1000, function() {
		self.emit('debug', 'socket timed out');
		self._connection.destroy();
	});

	this._connection.connect({
		"port": server.port,
		"host": server.host,
		"localAddress": this.localAddress,
		"localPort": this.localPort
	});
};

/**
 * Break our current connection without logging off. If we're connecting, cancel the connection.
 * If not connected or connecting, do nothing.
 */
CMClient.prototype.disconnect = function() {
	if (this._connection) {
		this._connection.destroy();
		this._connection.removeAllListeners();
		delete this._connection;
		if (this.loggedOn) {
			this.loggedOn = false;
			clearInterval(this._heartBeatFunc);
		}
		this.connected = false;
	} else if (this._scheduledConnection) {
		// there was an error and we're currently waiting
		clearTimeout(this._scheduledConnection);
		delete this._scheduledConnection;
	}
};

CMClient.prototype._send = function(header, body, callback) {
	if (callback) {
		var sourceJobID = ++this._currentJobID;
		this._jobs[sourceJobID] = callback;
	}

	if (header.msg == EMsg.ChannelEncryptResponse) {
		header.sourceJobID = sourceJobID;
		header = new Schema.MsgHdr(header);

	} else if (header.proto) {
		header.proto.client_sessionid = this._sessionID;
		header.proto.steamid = this.steamID;
		header.proto.jobid_source = sourceJobID;
		header = new Schema.MsgHdrProtoBuf(header);

	} else {
		header.steamID = this.steamID;
		header.sessionID = this._sessionID;
		header.sourceJobID = sourceJobID;
		header = new Schema.ExtendedClientMsgHdr(header);
	}

	this._connection.send(Buffer.concat([header.toBuffer(), body]));
};

/**
 * Send some data to Steam through our connection.
 * @param {object} header - Data to go in the message header
 * @param {Buffer|ByteBuffer} body - The message payload
 * @param {function} [callback] - If you expect a response to this message, a callback to be invoked when that response is received
 */
CMClient.prototype.send = function(header, body, callback) {
	// ignore any target job ID
	if (header.proto) {
		delete header.proto.jobid_target;
	} else {
		delete header.targetJobID;
	}

	if (ByteBuffer.isByteBuffer(body)) {
		body = body.toBuffer();
	}

	this._send(header, body, callback);
};

CMClient.prototype._netMsgReceived = function(data) {
	var rawEMsg = data.readUInt32LE(0);
	var eMsg = rawEMsg & ~PROTO_MASK;

	data = ByteBuffer.wrap(data, ByteBuffer.LITTLE_ENDIAN);

	var header, sourceJobID, targetJobID;
	if (eMsg == EMsg.ChannelEncryptRequest || eMsg == EMsg.ChannelEncryptResult) {
		header = Schema.MsgHdr.decode(data);
		sourceJobID = header.sourceJobID;
		targetJobID = header.targetJobID;

	} else if (rawEMsg & PROTO_MASK) {
		header = Schema.MsgHdrProtoBuf.decode(data);
		header.proto = Steam._processProto(header.proto);
		if (!this._sessionID && header.headerLength > 0) {
			this._sessionID = header.proto.client_sessionid;
			this.steamID = header.proto.steamid;
		}
		sourceJobID = header.proto.jobid_source;
		targetJobID = header.proto.jobid_target;

	} else {
		header = Schema.ExtendedClientMsgHdr.decode(data);
		sourceJobID = header.sourceJobID;
		targetJobID = header.targetJobID;
	}

	var body = data.toBuffer();

	if (eMsg in handlers) {
		handlers[header.msg].call(this, body);
	}

	if (sourceJobID != '18446744073709551615') {
		var callback = function(header, body, callback) {
			if (header.proto) {
				header.proto.jobid_target = sourceJobID;
			} else {
				header.targetJobID = sourceJobID;
			}

			this._send(header, body, callback);
		}.bind(this);
	}

	if (targetJobID in this._jobs) {
		this._jobs[targetJobID](header, body, callback);
	} else {
		this.emit('message', header, body, callback);
	}
};

CMClient.prototype._disconnected = function(had_error) {
	this.emit('debug', 'socket closed' + (had_error ? ' with an error' : ''));
	delete this._connection;

	if (this.connected) {
		if (this.loggedOn) {
			this.emit('debug', 'unexpected disconnection');
			this.loggedOn = false;
			clearInterval(this._heartBeatFunc);
		}

		this.connected = false;
		this.emit('error', new Error('Disconnected'));
		return;
	}

	if (!this._autoRetry) {
		var err = new Error('Cannot Connect');
		err.hadError = err;

		this.emit('error', err);
		return;
	}

	if (!had_error) {
		this.connect(this._server);
		return;
	}

	var timeout = this._timeout || 1;
	this.emit('debug', 'waiting ' + timeout + ' secs');
	this._scheduledConnection = setTimeout(function() {
		delete this._scheduledConnection;
		this.connect(this._server);
	}.bind(this), timeout * 1000);

	this._timeout = timeout * 2;
};


// Handlers

var handlers = {};

handlers[EMsg.ChannelEncryptRequest] = function(data) {
	// assume server isn't dead
	this._connection.setTimeout(0);

//  var encRequest = Schema.MsgChannelEncryptRequest.decode(data);
	this.emit('debug', 'encrypt request');

	var sessionKey = SteamCrypto.generateSessionKey();
	this._tempSessionKey = sessionKey.plain;
	var keyCrc = BufferCRC32.signed(sessionKey.encrypted);

	var encResp = new Schema.MsgChannelEncryptResponse().encode();
	var body = new ByteBuffer(encResp.limit + 128 + 4 + 4, ByteBuffer.LITTLE_ENDIAN); // key, crc, trailer

	body.append(encResp);
	body.append(sessionKey.encrypted);
	body.writeInt32(keyCrc);
	body.writeUint32(0); // TODO: check if the trailer is required
	body.flip();

	this.send({"msg": EMsg.ChannelEncryptResponse}, body.toBuffer());
};

handlers[EMsg.ChannelEncryptResult] = function(data) {
	var encResult = Schema.MsgChannelEncryptResult.decode(data);

	if (encResult.result == Steam.EResult.OK) {
		this._connection.sessionKey = this._tempSessionKey;
	} else {
		this.emit('error', new Error("Encryption fail: " + encResult.result));
		return;
	}

	this.connected = true;
	this.emit('connected');
};

handlers[EMsg.Multi] = function(data) {
	var msgMulti = Schema.CMsgMulti.decode(data);

	var payload = msgMulti.message_body.toBuffer();

	if (msgMulti.size_unzipped) {
		var zip = new Zip(payload);
		payload = zip.readFile('z');
	}

	// stop handling if user disconnected
	while (payload.length && this.connected) {
		var subSize = payload.readUInt32LE(0);
		this._netMsgReceived(payload.slice(4, 4 + subSize));
		payload = payload.slice(4 + subSize);
	}
};

handlers[EMsg.ClientLogOnResponse] = function(data) {
	var logonResp = Schema.CMsgClientLogonResponse.decode(data);
	var eresult = logonResp.eresult;

	if (eresult == Steam.EResult.OK) {
		var hbDelay = logonResp.out_of_game_heartbeat_seconds;

		this._heartBeatFunc = setInterval(function() {
			this.send({
				"msg": EMsg.ClientHeartBeat,
				"proto": {}
			}, new Schema.CMsgClientHeartBeat().toBuffer());
		}.bind(this), hbDelay * 1000);

		this.loggedOn = true;
	}

	this.emit('logOnResponse', Steam._processProto(logonResp));
};

handlers[EMsg.ClientLoggedOff] = function(data) {
	this.loggedOn = false;
	clearInterval(this._heartBeatFunc);

	var eresult = Schema.CMsgClientLoggedOff.decode(data).eresult;

	this.emit('loggedOff', eresult);
};

handlers[EMsg.ClientCMList] = function(data) {
	var list = Schema.CMsgClientCMList.decode(data);
	var servers = list.cm_addresses.map(function(number, index) {
		var buf = new Buffer(4);
		buf.writeUInt32BE(number, 0);
		return {
			host: [].join.call(buf, '.'),
			port: list.cm_ports[index]
		};
	});

	this.emit('servers', servers);
	Steam.servers = servers;
};


Steam.CMClient = CMClient;