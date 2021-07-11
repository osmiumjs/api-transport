const nTools = require('@osmium/tools');
const {parseScript} = require('meriyah');
const {ApiTransportProto} = require('./apiTransportProto');
const {ApiTransportProtoVersion} = require('./common');
const {Events} = require('@osmium/events');

/**
 * @class {ApiTransport&ApiTransportProto}
 */
class ApiTransport extends ApiTransportProto {
	constructor(socket, isServer = false, options = {}) {
		super(options, isServer);

		this.options = Object.assign({
			prefix             : '',
			timeout            : 1000 * 60 * 10,
			local              : false,
			throwStatusMessages: true
		}, options);
		this.isLocal = this.options.local;

		const getEventName = (isServer, cmd) =>
			`${this.options.prefix}${isServer ? (cmd ? 'a' : 'b') : (cmd ? 'c' : 'd')}`;

		this.onceIds = {};

		Object.assign(this.options, {
			version         : ApiTransportProtoVersion,
			cmdToTarget     : getEventName(this.isServer, true),
			cmdToTargetRet  : getEventName(this.isServer, false),
			cmdFromTarget   : getEventName(!this.isServer, true),
			cmdFromTargetRet: getEventName(!this.isServer, false)
		});

		this.socketEvents = new Events();
		this.socket = false;

		if (!this.isLocal) {
			this.socket = socket;
			this.socket.on('connect', () => {
				this.socket.socketId = this.socket.id;
				nTools.iterate(this.onConnects, (fn) => fn(this.socket));
			});
			this.socket.on('disconnect', () => nTools.iterate(this.onDisconnects, (fn) => fn(this.socket)));
		}

		//Outgoing command - before
		this.use(async (...args) => await this.outcomingCmdHandler(...args));
		//Outgoing command - after
		if (!this.isLocal) this.socket.on(this.options.cmdToTargetRet, async (packet) => await this.incomingRetHandler(packet));

		//Incoming command - before
		if (!this.isLocal) this.socket.on(this.options.cmdFromTarget, async (packet) => await this.incomingCmdHandler(packet));
		//Incoming command - after
		this.useAfter(async (...args) => await this.outcomingRetHandler(...args));

		setInterval(() => {
			nTools.iterate(this.onceIds, (once, id) => {
				if (once.t >= Date.now()) return;
				this.socketEvents.emit(once.id, this.TIMEOUT);
				delete this.onceIds[id];
			});
		}, 5000);
	}

	meta(what) {
		return this._makeEmitter(what, this.emitters.meta);
	}

	timeout(ms) {
		return this._makeEmitter(ms, this.emitters.timeout);
	}

	_extractFunctionArgs(fn) {
		try {
			const parsedAst = parseScript(`(()=>{})(${fn.toString()})`, {next: true, compat: true});
			return parsedAst.body[0].expression.arguments[0].params.map(val => val.left ? val.left.name : val.name);
		} catch (e) {
			return [];
		}
	}

	_injectToArgs(fn, injects, args) {
		let aCnt = 0;

		const res = [];
		nTools.iterate(this._extractFunctionArgs(fn), (arg) => {
			if (arg[0] === '$') {
				const name = injects[arg.substr(1)];
				return res.push(!nTools.isUndefined(name) ? name : {});
			}
			aCnt++;

			res.push(args[aCnt - 1]);
		});
		return res;
	}

	/**
	 * @param {*} mwStorage
	 * @param {Packet} packet
	 * @param {Boolean} [isAfter=false]
	 * @param {{}} [mwConfig={}]
	 * @returns {Promise<void>}
	 */
	async mwIterate(mwStorage, packet, isAfter = false, mwConfig = {}) {
		packet.injects = packet.injects || {};
		Object.assign(packet.injects, {
			packet,
			mwConfig,
			id          : packet.id,
			name        : packet.name,
			args        : packet.args,
			meta        : packet.meta,
			socket      : this.socket,
			isAfter     : isAfter,
			isBefore    : !isAfter,
			isServer    : this.isServer,
			isLocal     : this.isLocal,
			minddlewares: mwStorage,
			instance    : this,
			mwAffected  : [],
			setArgs     : (args) => packet.args = args,
			setArg      : (idx, val) => packet.args[idx] = val,
			add         : (key, value) => {
				if (nTools.isString(key)) packet.injects[key] = value;
				if (nTools.isObject(key)) Object.assign(packet.injects, key);
			},
			del         : (key) => delete packet.injects[key],
			get         : (key) => packet.injects[key],
			drop        : () => packet.dropped = true,
			break       : (ret) => {
				packet.breaked = true;
				packet.args = [ret];
			},
			skipMw      : () => packet.skipMw = true
		});

		function _update() {
			Object.assign(packet.injects, {
				packet,
				id  : packet.id,
				name: packet.name,
				args: packet.args,
				meta: packet.meta
			});
		}

		_update();

		await nTools.iterate(mwStorage, async (mwRow, idx, iter1) => {
			if (!packet) return iter1.break();

			await nTools.iterate(mwRow, async (mw, _, iter2) => {
				if (mw.isAfter !== null && mw.isAfter !== isAfter) return;
				packet.injects.mwAffected.push(mw.id);

				let ret;
				try {
					ret = await mw.fn.apply(packet.injects, this._injectToArgs(mw.fn, packet.injects, []));
				} catch (e) {
					packet.injects.break(this.API_ERROR);
					packet.hasError = true;
					packet.errorDescription = e;
				}

				_update();

				if (!nTools.isUndefined(ret)) {
					packet.breaked = true;
					packet.args = [ret];
				}

				if (packet.skipMw) {
					iter1.break();
					iter2.break();
				}
			});
		});
	}

	filterPacket(packet) {
		return nTools.iterate(this.packetSchema, (idx, _, iter) => {
			iter.key(idx);
			return packet[idx];
		}, {});
	}

	async serializePacket(packet) {
		const filtred = this.filterPacket(packet);
		try {
			return !this.coderOverride ? this.serializer.serialize(filtred) : await this.coderOverride.serialize(filtred);
		} catch (e) {
			if (!packet.name) console.log('Error in serializePacket, incorrect packet: ', packet);
			throw new Error(`Cant filter/serialize packet in [${packet.name}], serializer error - ${e}`);
		}
	}

	checkPacket(packet) {
		return nTools.isObject(packet)
			   && nTools.isString(packet.id)
			   && nTools.isString(packet.name)
			   && nTools.isArray(packet.args)
			   && nTools.isObject(packet.meta)
			   && packet.version === ApiTransportProtoVersion;
	}

	_getEmitterById(id) {
		let ret = false;
		nTools.iterate(this.emitters, (val, idx, iter) => {
			if (val !== id) return;
			iter.break();
			ret = idx;
		});
		return ret;
	}

	async outcomingCmdHandler(name, options, ...args) {
		if (options.skipApiHandler) return nTools.nop$(); //incomingCmdHandler via emitEx bypass

		let timeout = this.options.timeout;
		const id = nTools.UID('^');
		const packet = this.makePacket(id, name.trim(), args);

		if (nTools.isObject(args[0]) && args[0].id && !nTools.isUndefined(args[0].what)) {
			const emitter = this._getEmitterById(args[0].id);
			if (emitter) {
				switch (emitter) {
					case 'timeout':
						timeout = args[0].what;
						break;
					case 'meta':
						Object.assign(packet.meta, args[0].what);
						break;
				}
				args.splice(0, 1);
			}
		}

		await this.mwIterate(this.middlewaresOut, packet, false);

		if (packet.hasError) throw packet.errorDescription;
		if (!nTools.isObject(packet) || packet.dropped) return new Promise(resolve => resolve(undefined));
		if (packet.breaked) return new Promise(resolve => resolve(packet.args[0]));

		const promise = new Promise((resolve, reject) => {
			const onceId = this.socketEvents.once(id, (ret, hasError, errorDescription) => {
				if (hasError) reject(errorDescription);
				if (this.options.throwStatusMessages) {
					if (ret === this.API_ERROR) return reject('API_ERROR');
					if (ret === this.NOT_FOUND) return reject('API_NOT_FOUND');
					if (ret === this.TIMEOUT) return reject('API_TIMEOUT');
				}
				resolve({ret});
			});
			this.onceIds[onceId] = {t: Date.now() + timeout, id};
		});

		if (packet && !this.isLocal) this.socket.compress(false).emit(this.options.cmdToTarget, await this.serializePacket(packet));
		if (packet && this.isLocal) {
			let ret = await this.emitEx(packet.name, true, {
				skipApiHandler: true,
				apiPacketId   : false
			}, ...(nTools.isArray(packet.args) ? packet.args : [packet.args]));

			ret = nTools.iterate(ret, (row) => row, []);
			if (ret.length === 1) ret = ret[0];
			packet.args = [ret];
			await this.incomingRetHandler(await this.serializePacket(packet));
		}

		return promise;
	}

	async incomingCmdHandler(rawPacket) {
		/**
		 * @type {Packet}
		 */
		let packet = false;
		try {
			packet = !this.coderOverride ? this.serializer.deserialize(rawPacket, this.packetSchema) : await this.coderOverride.deserialize(rawPacket, this.packetSchema);
		} catch (e) { }
		if (!this.checkPacket(packet)) return;

		await this.mwIterate(this.middlewaresInc, packet, false);

		if (!nTools.isObject(packet) || packet.dropped) return;

		const middlewareReturn = (ret, addtional = {}) =>
			this.outcomingRetHandler(packet.name, Object.assign({apiPacketId: packet.id}, addtional), {'mwIncBefore': ret});

		if (packet.breaked) {
			await middlewareReturn(!packet.hasError ? packet.args[0] : this.API_ERROR, packet.hasError ? {hasError: true, errorDescription: packet.errorDescription} : {});
			return;
		}

		const handler = Object.values(this.middlewaresWrap).reverse().flatMap(middlewares => middlewares).reduce(
			(next, middleware) => async () => await middleware.fn(packet, next, middlewareReturn),
			async () => {
				if (!this.exists(packet.name, true)) return middlewareReturn(this.NOT_FOUND);
				try {
					return await this.emitEx(packet.name, true, {
						context       : packet.injects || {},
						preCall       : async (cb, args, id) => {
							packet.injects.eventId = id;
							return this._injectToArgs(cb, packet.injects, args);
						},
						skipApiHandler: true,
						apiPacketId   : packet.id
					}, ...packet.args);
				} catch (e) {
					await middlewareReturn(this.API_ERROR, {hasError: true, errorDescription: e});
				}
			}
		);
		return await handler();
	}

	async outcomingRetHandler(name, mwConfig, ret) {
		if ((!nTools.isObject(ret) || !mwConfig.apiPacketId) && (ret === this.NOT_FOUND || ret === this.API_ERROR)) return;
		const args = Object.keys(ret).length === 1
					 ? ret[Object.keys(ret)[0]]
					 : nTools.objectToArray(ret);
		let packet = this.makePacket(mwConfig.apiPacketId, name.trim(), [args]);
		await this.mwIterate(this.middlewaresInc, packet, true, mwConfig);

		if (!nTools.isObject(packet) || packet.dropped) return;
		if (this.isLocal) return;

		if (mwConfig.hasError) packet.args = [this.API_ERROR];
		this.socket.compress(false).emit(this.options.cmdFromTargetRet, await this.serializePacket(packet));
		if (packet.hasError || mwConfig.hasError) throw packet.errorDescription || mwConfig.errorDescription;
	}

	async incomingRetHandler(rawPacket) {
		/** @type {Packet} */
		const packet = !this.coderOverride ? this.serializer.deserialize(rawPacket, this.packetSchema) : await this.coderOverride.deserialize(rawPacket, this.packetSchema);
		if (!this.checkPacket(packet)) return;

		packet.name = packet.name.trim();

		await this.mwIterate(this.middlewaresOut, packet, true);

		if (!nTools.isObject(packet) || packet.dropped) return;
		if (packet.args.length === 1) packet.args = packet.args[0];
		await this.socketEvents.emit(packet.id, packet.args, packet.hasError, packet.errorDescription);
	}
}

module.exports = {ApiTransport};
