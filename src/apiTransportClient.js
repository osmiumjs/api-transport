const {ApiTransport} = require('./apiTransport');

/**
 * @class {ApiTransportClient&ApiTransport}
 */
class ApiTransportClient extends ApiTransport {
	/**
	 * @constructor
	 * @param socket
	 * @param options
	 * @return {ApiTransportClient&&ApiTransport&&ApiTransportProto&Events}
	 */
	static createInstance(socket, options = {}) {
		return new ApiTransportClient(socket, options);
	}

	/**
	 * @constructor
	 * @param socket
	 * @param options
	 * @return {ApiTransportClient&&ApiTransport&&ApiTransportProto&Events}
	 */
	constructor(socket, options = {}) {
		super(socket, !!options.isServer, options);
	}

	ready() {
		return new Promise((resolve) => this.socket.on('connect', resolve));
	}
}

module.exports = {ApiTransportClient};
