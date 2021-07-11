const nTools = require('@osmium/tools');
const {ApiTransportProtoVersion} = require('./common');
const {Events} = require('@osmium/events');
const {Serializer, DataCoder} = require('@osmium/coder');
const BigNumber = require('bignumber.js');
const moment = require('moment');

/**
 * @class {ApiTransportProto&Events}
 */
class ApiTransportProto extends Events {
	constructor(options = {}, isServer) {
		super();
		this.options = options;
		const mwI = {};
		const mwW = {};
		const mwO = {};
		this.middlewaresInc = mwI;
		this.middlewaresWrap = mwW;
		this.middlewaresOut = mwO;
		this.onConnects = [];
		this.onDisconnects = [];
		this.coderOverride = options.coderOverride || false;

		/** @type {DataCoder} */
		this.coder = new DataCoder();
		this.coder.use(0xF0, (v) => typeof v === 'symbol' && v.description === 'API_NOT_FOUND', () => Buffer.from(''), () => this.NOT_FOUND);
		this.coder.use(0xF1, (v) => typeof v === 'symbol' && v.description === 'UNDEFINED', v => Buffer.from(''), () => undefined);
		this.coder.use(0xF3, (v) => typeof v === 'symbol' && v.description === 'API_ERROR', () => Buffer.from(''), () => this.API_ERROR);
		this.coder.use(0xF2, (v) => v instanceof RegExp, (v) => {
			const regArr = v.toString().split('/').reverse();
			const flags = regArr[0];
			regArr[0] = '';
			let regExpStr = regArr.reverse().join('/');
			regExpStr = regExpStr.substr(1, regExpStr.length - 2);

			return this.coder.encode([regExpStr, flags]);
		}, (v) => {
			const rExp = this.coder.decode(v);
			return new RegExp(rExp[0], rExp[1]);
		});
		this.coder.use(0xFA, (v) => BigNumber.isBigNumber(v), (v) => this.coder.encode(v.toJSON()), (v) => new BigNumber(this.coder.decode(v)));
		this.coder.use(0xFB, (v) => moment.isMoment(v), (v) => this.coder.encode(v.toJSON()), (v) => moment(this.coder.decode(v)));
		this.coder.use(0xFC, (v) => moment.isDuration(v), (v) => this.coder.encode(v.toJSON()), (v) => moment.duration(this.coder.decode(v)));

		this.serializer = new Serializer(false, this.coder);

		this.packetSchema = Object.keys(this.makePacket(null, null, null));

		this.isServer = isServer;
		this.PRIORITY = {
			FIRST : 10,
			NORMAL: 1000,
			LAST  : 1990
		};
		this.emitters = {
			meta   : '~M7PN9OehiioEmGFHNU-C4Frvm',
			timeout: '~4AP2K7lq183qFj39fe-UVG5a4'
		};
		this.NOT_FOUND = Symbol('API_NOT_FOUND');
		this.TIMEOUT = Symbol('API_TIMEOUT');
		this.API_ERROR = Symbol('API_ERROR');
	}

	isMessageHasAPIStatus(message) {
		return message === this.NOT_FOUND || message === this.TIMEOUT || message === this.API_ERROR;
	}

	isStatusNotFound(message) {
		return message === this.NOT_FOUND;
	}

	isStatusTimeout(message) {
		return message === this.TIMEOUT;
	}

	isStatusError(message) {
		return message === this.API_ERROR;
	}

	useCoder(...args) {
		throw new Error('Not implemented now');
	}

	/**
	 * @param {String} id
	 * @param {String} name
	 * @param {*[]} args
	 * @returns Packet
	 */
	makePacket(id, name, args) {
		return {
			version: ApiTransportProtoVersion,
			id,
			name,
			args,
			meta   : {},
			breaked: false
		};
	}

	_makeEmitter(what, id) {
		return {
			emit: async (name, ...args) => await this.emit(name, {what, id}, ...args)
		};
	}

	_registerMiddleware(storage, idx, fn, isAfter) {
		if (nTools.isFunction(idx)) {
			fn = idx;
			idx = this.PRIORITY.NORMAL;
		}
		if (!nTools.isFunction(fn)) return false;

		const id = nTools.UID('%');

		storage[idx] = storage[idx] || [];
		storage[idx].push({
			id,
			fn,
			isAfter
		});

		return id;
	}

	getMiddleware(id) {
		let ret = false;
		const _find = (where) => nTools.iterate(where, (mws, idx, iter1) => nTools.iterate(mws, (mw, pos, iter2) => {
			if (mw.id !== id) return;
			iter1.break();
			iter2.break();
			ret = Object.assign({idx, pos}, mw);
		}));

		_find(this.middlewaresInc);
		if (!ret) _find(this.middlewaresOut);
		return ret;
	}

	middlewareInc(idx, fn, isAfter = null) {
		return this._registerMiddleware(this.middlewaresInc, idx, fn, isAfter);
	}

	middlewareWrap(idx, fn) {
		return this._registerMiddleware(this.middlewaresWrap, idx, fn, false);
	}

	middlewareOut(idx, fn, isAfter = null) {
		return this._registerMiddleware(this.middlewaresOut, idx, fn, isAfter);
	}

	middlewareIncBefore(idx, fn) {
		return this.middlewareInc(idx, fn, false);
	}

	middlewareIncAfter(idx, fn) {
		return this.middlewareInc(idx, fn, true);
	}

	middlewareOutBefore(idx, fn) {
		return this.middlewareOut(idx, fn, false);
	}

	middlewareOutAfter(idx, fn) {
		return this.middlewareOut(idx, fn, true);
	}

	/**
	 * @param {function(Socket)} fn
	 */
	onConnect(fn) {
		this.onConnects.push(fn);
	}

	/**
	 * @param {function(Socket)} fn
	 */
	onDisconnect(fn) {
		this.onDisconnects.push(fn);
	}
}

module.exports = {ApiTransportProto};
