/** @typedef {SocketIOClient.Socket&{socketId:string}} Socket */

/** @typedef {Object|Boolean} Packet
 *  @property {String} id
 *  @property {Number} version
 *  @property {String} name
 *  @property {*[]} args
 *  @property {Object} meta
 *  @property {Boolean} breaked
 *  @property {Boolean} [dropped]
 *  @property {Boolean} [skipMw]
 *  @property {Object} [injects]
 */

const ApiTransportProtoVersion = 2;

module.exports = {ApiTransportProtoVersion};
