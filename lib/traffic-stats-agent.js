import http from 'http';
import https from 'https';
import tls from 'tls';
import net from 'net';
import { SocksClient } from 'socks';

export class HttpTrafficStatsAgent extends http.Agent {
    /**
     * 
     * @param {http.AgentOptions} options  Agent options
     * @param {typeof { tx: 0, rx: 0 }} register  proxy url (http/socks)
     * @param {string} proxy  proxy url (http/socks)
     */
    constructor(options = {}, register = { tx: 0, rx: 0 }, proxy = null) {
        super(options);
        this.trafficStatsRegister = register
        this.proxy = proxy;
    }

    createConnection(options, callback) {
        // 处理代理连接
        if (this.proxy) {
            this.createProxyConnection(options, (err, socket) => {
                if (err) return callback(err);
                this.setupSocketTracking(socket);
                callback(null, socket);
            });
            return; // 返回 undefined，连接将通过回调处理
        }

        // 无代理的直接连接
        const socket = super.createConnection(options, callback);
        this.setupSocketTracking(socket);
        return socket;
    }

    createProxyConnection(options, callback) {
        const proxyUrl = new URL(this.proxy);
        const target = {
            host: options.host,
            port: options.port || 80
        };

        // SOCKS 代理
        if (proxyUrl.protocol.startsWith('socks')) {
            this.createSocksConnection(proxyUrl, target, callback);
            return;
        }

        // HTTP 代理
        this.createHttpProxyConnection(proxyUrl, target, callback);
    }

    createSocksConnection(proxyUrl, target, callback) {
        SocksClient.createConnection({
            proxy: {
                host: proxyUrl.hostname,
                port: parseInt(proxyUrl.port),
                type: proxyUrl.protocol === 'socks:' ? 4 : 5
            },
            destination: {
                host: target.host,
                port: target.port
            },
            command: 'connect'
        }, (err, info) => {
            if (err) return callback(err);
            callback(null, info.socket);
        });
    }

    createHttpProxyConnection(proxyUrl, target, callback) {
        // 连接到代理服务器
        const proxySocket = net.connect({
            host: proxyUrl.hostname,
            port: parseInt(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80)
        });

        let receivedData = Buffer.alloc(0);
        let connected = false;

        const onData = (data) => {
            if (connected) return;

            receivedData = Buffer.concat([receivedData, data]);
            if (receivedData.includes('\r\n\r\n')) {
                proxySocket.removeListener('data', onData);

                const statusCode = receivedData.toString().split(' ')[1];
                if (statusCode === '200') {
                    connected = true;
                    callback(null, proxySocket);
                } else {
                    proxySocket.destroy();
                    callback(new Error(`Proxy connection failed: ${receivedData.toString()}`));
                }
            }
        };

        const onError = (err) => {
            cleanup();
            callback(err);
        };

        const onClose = () => {
            if (!connected) {
                cleanup();
                callback(new Error('Proxy connection closed before complete'));
            }
        };

        const cleanup = () => {
            proxySocket.removeListener('data', onData);
            proxySocket.removeListener('error', onError);
            proxySocket.removeListener('close', onClose);
        };

        proxySocket.on('data', onData);
        proxySocket.on('error', onError);
        proxySocket.on('close', onClose);

        // 发送CONNECT请求建立隧道
        proxySocket.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`);
    }

    /**
     * 
     * @param {net.Socket} socket 
     */
    setupSocketTracking(socket) {
        const originalWrite = socket.write;
        const agent = this;
        // 跟踪发送数据量
        socket.write = function (chunk, encoding, callback) {
            if (chunk) {
                const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
                agent.trafficStatsRegister.tx += size;
            }
            return originalWrite.call(this, chunk, encoding, callback);
        };

        // 跟踪接收数据量
        socket.on('data', (chunk) => {
            this.trafficStatsRegister.rx += chunk.length;
        });
    }
}

export class HttpsTrafficStatsAgent extends https.Agent {
    /**
    * 
    * @param {http.AgentOptions} options  Agent options
    * @param {typeof { tx: 0, rx: 0 }} register  proxy url (http/socks)
    * @param {string} proxy  proxy url (http/socks)
    */
    constructor(options = {}, register = { tx: 0, rx: 0 }, proxy = null) {
        super(options);
        this.trafficStatsRegister = register
        this.proxy = proxy;
    }

    createConnection(options, callback) {
        // 创建基础连接（代理或直接）
        this.createBaseConnection(options, (err, rawSocket) => {
            if (err) return callback(err);

            // 设置TLS连接
            const tlsSocket = tls.connect({
                socket: rawSocket,
                host: options.host,
                servername: options.servername || options.host,
                rejectUnauthorized: false
            });

            // 流量统计
            tlsSocket.on('close', () => {
                this.trafficStatsRegister.tx += rawSocket.bytesWritten;
                this.trafficStatsRegister.rx += rawSocket.bytesRead;
            });

            tlsSocket.on('secureConnect', () => {
                callback(null, tlsSocket);
            });

            tlsSocket.on('error', (err) => {
                callback(err);
            });
        });

        // 返回 undefined，连接将通过回调处理
        return;
    }

    createBaseConnection(options, callback) {
        if (this.proxy) {
            this.createProxyConnection(options, callback);
        } else {
            this.createDirectConnection(options, callback);
        }
    }

    createProxyConnection(options, callback) {
        const proxyUrl = new URL(this.proxy);
        const target = {
            host: options.host,
            port: options.port || 443
        };

        // SOCKS代理
        if (proxyUrl.protocol.startsWith('socks')) {
            this.createSocksConnection(proxyUrl, target, callback);
            return;
        }

        // HTTP代理
        this.createHttpProxyConnection(proxyUrl, target, callback);
    }

    createSocksConnection(proxyUrl, target, callback) {
        SocksClient.createConnection({
            proxy: {
                host: proxyUrl.hostname,
                port: parseInt(proxyUrl.port),
                type: proxyUrl.protocol === 'socks:' ? 4 : 5
            },
            destination: {
                host: target.host,
                port: target.port
            },
            timeout: 3600000,
            command: 'connect'
        }, (err, info) => {
            if (err) return callback(err);
            callback(null, info.socket);
        });
    }

    createHttpProxyConnection(proxyUrl, target, callback) {
        // 连接到代理服务器
        const proxySocket = net.connect({
            host: proxyUrl.hostname,
            port: parseInt(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80)
        });

        let receivedData = Buffer.alloc(0);
        let connected = false;

        const onData = (data) => {
            if (connected) return;

            receivedData = Buffer.concat([receivedData, data]);
            if (receivedData.includes('\r\n\r\n')) {
                proxySocket.removeListener('data', onData);

                const statusCode = receivedData.toString().split(' ')[1];
                if (statusCode === '200') {
                    connected = true;
                    callback(null, proxySocket);
                } else {
                    proxySocket.destroy();
                    callback(new Error(`Proxy connection failed: ${receivedData.toString()}`));
                }
            }
        };

        const onError = (err) => {
            cleanup();
            callback(err);
        };

        const onClose = () => {
            if (!connected) {
                cleanup();
                callback(new Error('Proxy connection closed before complete'));
            }
        };

        const cleanup = () => {
            proxySocket.removeListener('data', onData);
            proxySocket.removeListener('error', onError);
            proxySocket.removeListener('close', onClose);
        };

        proxySocket.on('data', onData);
        proxySocket.on('error', onError);
        proxySocket.on('close', onClose);

        // 发送CONNECT请求建立隧道
        proxySocket.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`);
    }

    createDirectConnection(options, callback) {
        const socket = net.connect({
            host: options.host,
            port: options.port || 443
        }, () => {
            callback(null, socket);
        });

        socket.on('error', callback);
    }
}

/**
 * 
 * @param {http.AgentOptions} options  Agent options
 * @param {typeof { tx: 0, rx: 0 }} register  proxy url (http/socks)
 * @param {string} proxy  proxy url (http/socks)
 */
export default function TrafficStatsAgent(options, register, proxy) {
    const http = new HttpTrafficStatsAgent(options, register, proxy)
    const https = new HttpsTrafficStatsAgent(options, register, proxy)
    // const http2 = https
    // return { http, https, http2 }
    return { http, https }
}

