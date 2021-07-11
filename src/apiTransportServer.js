require('./common');
const nTools = require('@osmium/tools');
const {ApiTransportProto} = require('./apiTransportProto');
const {ApiTransport} = require('./apiTransport');

class ApiTransportServer extends ApiTransportProto {
	/**
	 * @constructor
	 * @param io
	 * @param options
	 * @return {ApiTransportServer&ApiTransportProto&Events}
	 */
	static createInstance(io, options) {
		return new ApiTransportServer(io, options);
	}

	/**
	 * @constructor
	 * @param io
	 * @param options
	 * @return {ApiTransportServer&ApiTransportProto&Events}
	 */
	constructor(io, options) {
		super(options, true);
		this.options = Object.assign({
			emitTimeout    : 1000 * 60 * 8,
			clientProcessor: false
		}, options);

		this.handlers = this.options.handlers || {};
		this.use((...args) => this.emitHandler(...args));

		if (io) {
			io.on('connection', (socket) => {
				this.registerHandler(socket);
				socket.socketId = socket.id;
				nTools.iterate(this.onConnects, (fn) => fn(socket));
			});
		}
		this.coderOverride = this.options.coderOverride || false;
	};

	async emitHandler(name, options, ...args) {
		if (options.fromMapper) return;
		let promises = nTools.iterate(this.handlers, (handler, hid) => {
			return new Promise(async (resolve) => {
				const tId = setTimeout(() => resolve({timeout: true, hid}), this.options.emitTimeout);
				resolve({ret: await handler.emit(name, ...args), timeout: false, hid});
				clearTimeout(tId);
			});
		}, []);

		const ret = nTools.iterate(await Promise.all(promises), (row, _, iter) => {
			iter.key(row.hid);
			return row.timeout ? null : row.ret;
		}, {});
		return {ret};
	}

	/**
	 * @param {{}} what
	 * @returns {{emit: (function(*=, ...[*]): *)}}
	 */
	meta(what) {
		return this._makeEmitter(what, this.emitters.meta);
	}

	/**
	 * @param {string|[string]} dest
	 * @returns {ApiTransportServer}
	 */
	to(dest) {
		const handlers = nTools.iterate(nTools.toArray(dest), (row, _, iter) => {
			const sId = nTools.isObject(row) ? row.id : nTools.isFunction(row) ? row(this) : row;
			if (!this.handlers[sId]) return;
			iter.key(sId);
			return this.handlers[sId];
		}, {});
		return new ApiTransportServer(false, {handlers});
	}

	/** @param {ApiTransport|false} clientProcessor */
	assignMw(clientProcessor) {
		Object.assign(this.middlewaresInc, clientProcessor.middlewaresInc);
		clientProcessor.middlewaresInc = this.middlewaresInc;

		Object.assign(this.middlewaresWrap, clientProcessor.middlewaresWrap);
		clientProcessor.middlewaresWrap = this.middlewaresWrap;

		Object.assign(this.middlewaresOut, clientProcessor.middlewaresOut);
		clientProcessor.middlewaresOut = this.middlewaresOut;
	}

	local() {
		const clientProcessor = new ApiTransport(false, true, {local: true, coderOverride: this.coderOverride});

		this.assignMw(clientProcessor);
		clientProcessor.mapEvents(this);

		return clientProcessor;
	}

	/** @param {Socket} socket */
	registerHandler(socket) {
		socket.on('disconnect', () => {
			nTools.iterate(this.onDisconnects, (fn) => fn(socket));
			this.unRegisterHandelr(socket);
		});

		const clientProcessor = this.options.clientProcessor
								? this.options.clientProcessor(socket, true, this.options)
								: new ApiTransport(socket, true, Object.assign(this.options, {coderOverride: this.coderOverride}));

		this.assignMw(clientProcessor);
		clientProcessor.mapEvents(this);

		this.handlers[socket.id] = clientProcessor;
	};

	/** @param {Socket} socket */
	unRegisterHandelr(socket) {
		delete this.handlers[socket.id];
	}
}

module.exports = {ApiTransportServer};
