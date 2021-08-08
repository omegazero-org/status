/*
 * Copyright (C) 2021 omegazero.org
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Covered Software is provided under this License on an "as is" basis, without warranty of any kind,
 * either expressed, implied, or statutory, including, without limitation, warranties that the Covered Software
 * is free of defects, merchantable, fit for a particular purpose or non-infringing.
 * The entire risk as to the quality and performance of the Covered Software is with You.
 */
"use strict";

const net = require("net");
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");
const crypto = require("crypto");
const zlib = require("zlib");
const dns = require("dns");

const omzlib = require("./omz-js-lib");
const logger = omzlib.logger;

const HMgr = require("./hmgr.js");


const VERSION = "2.1.0";
const BRAND = "omz-status/" + VERSION;

const visibilityThreshold = 0.5;

const DEFAULT_PORT = 27115;


const initTime = Date.now();

const srcRoot = getSrcRoot();

const pargs = new omzlib.args(process.argv);

const configFile = pargs.getValueOrDefault("configFile", "config.json");

const logLevel = pargs.getNumberOrDefault("logLevel", 3);
const logFile = pargs.getValue("logFile");

let statusLocalAddress = null;
let statusPort = DEFAULT_PORT;
let pollInterval = 60;
let requestRateLimit = pollInterval / 2;
let dataDir = "data";
let historySubDir = "history";
let measurementHistorySubDir = "measurements";
let allowedStatusClients = ["127.0.0.1", "::1"];
let webserverAddress = "127.0.0.1";
let webserverPort = 8080;
let siteVars = {};
let statusMessageFile = "status.json";
let useCustomStylesheet = false;
let entryBuilders = [];
let key = null;
let nodes = [];
let measurements = [];
let webpageOrder = [];
let webpageFootnotes = [];

let thisNodeId = -1;

const publicNodesStatus = [];
const localNodesStatus = [];
const localMeasurementStatus = [];

const requestClients = {};

const measurers = {};

let configFileWatcher;

let serverSocket;
let pollIntervalI;

let webserver;
const webroot = path.resolve(srcRoot + "www");

let ownVisibility = 0; // our absolute visibility

let statusMessages = [];
let statusMessagesUpdated = 0;
let lastStatusMsgPoll = 0;



run();


function run(){
	logger.init(logLevel, logFile != "null" && logFile);

	omzlib.util.initPrototypes();

	omzlib.util.initHandlers(shutdown);

	HMgr.setLogger(logger.copy("history"));

	Number.prototype.shl = function(bits){
		return this * Math.pow(2, bits);
	};

	Number.prototype.shr = function(bits){
		return Math.floor(this / Math.pow(2, bits));
	};

	try{
		loadConfig();
	}catch(e){
		logger.fatal("Error while loading configuration: " + e);
		shutdown(1);
		return;
	}

	serverSocket = dgram.createSocket("udp4");
	serverSocket.bind({address: statusLocalAddress, port: statusPort}, () => {
		let addr = serverSocket.address();
		logger.info("Listening on " + addr.address + ":" + addr.port);
	});
	serverSocket.on("message", onServerMessage);

	if(pollInterval)
		pollIntervalI = setInterval(pollAllNodes, pollInterval * 1000);

	startMeasurements();

	setInterval(fixAllHistoryData, 600000).unref();

	if(webserverPort > 0){
		webserver = http.createServer(http_client);
		webserver.on("error", (e) => {
			logger.fatal("Webserver error: " + e);
		});
		webserver.listen({host: webserverAddress, port: webserverPort}, () => {
			let addr = webserver.address();
			logger.info("Webserver listening on " + addr.address + ":" + addr.port);
		});
	}
}

function getConfig(){
	return JSON.parse(fs.readFileSync(configFile));
}

function loadConfig(){
	if(configFile != "null"){
		logger.info("Loading configuration file '" + configFile + "'");
		let json = getConfig();
		if(typeof(json.statusLocalAddress) == "string")
			statusLocalAddress = json.statusLocalAddress;
		if(typeof(json.statusPort) == "number")
			statusPort = json.statusPort;
		if(typeof(json.pollInterval) == "number")
			pollInterval = Math.max(json.pollInterval, 0);
		if(typeof(json.requestRateLimit) == "number")
			requestRateLimit = Math.max(json.requestRateLimit, 0);
		else
			requestRateLimit = pollInterval / 2;
		if(typeof(json.dataDir) == "string")
			dataDir = json.dataDir;
		if(typeof(json.historySubDir) == "string")
			historySubDir = json.historySubDir;
		if(typeof(json.measurementHistorySubDir) == "string")
			measurementHistorySubDir = json.measurementHistorySubDir;
		reloadMConfig(json);
		if(Array.isArray(json.allowedStatusClients))
			allowedStatusClients = json.allowedStatusClients;
		if(typeof(json.webserverAddress) == "string")
			webserverAddress = json.webserverAddress;
		if(typeof(json.webserverPort) == "number")
			webserverPort = json.webserverPort;
		if(typeof(json.siteVars) == "object")
			siteVars = json.siteVars;
		if(typeof(json.statusMessageFile) == "string")
			statusMessageFile = json.statusMessageFile;
		if(typeof(json.useCustomStylesheet) == "boolean")
			useCustomStylesheet = json.useCustomStylesheet;
		if(Array.isArray(json.entryBuilders))
			entryBuilders = json.entryBuilders;

		if(typeof(json.key) == "string"){
			let kb = Buffer.from(json.key, "hex");
			if(kb.length != 32)
				throw new Error("key must be 32 bytes");
			key = kb;
		}else
			logger.warn("key is not configured, messages will be sent unencrypted");

		if(json.configReload){
			configFileWatcher = (json.useStatWatcher ? fs.watchFile : fs.watch)(configFile, () => {
				logger.info("Configuration file changed, reloading measurements");
				try{
					reloadMConfig();
					startMeasurements();
				}catch(e){
					logger.warn("Error while reloading measurements: " + e);
				}
			});
			if(typeof(configFileWatcher.unref) == "function")
				configFileWatcher.unref();
		}

		dataDir = path.resolve(dataDir) + "/";
		if(!fs.existsSync(dataDir))
			fs.mkdirSync(dataDir);
		historySubDir = path.resolve(dataDir + historySubDir) + "/";
		if(!fs.existsSync(historySubDir))
			fs.mkdirSync(historySubDir);
		measurementHistorySubDir = path.resolve(dataDir + measurementHistorySubDir) + "/";
		if(!fs.existsSync(measurementHistorySubDir))
			fs.mkdirSync(measurementHistorySubDir);

		if(pollInterval < 5)
			logger.warn("pollInterval is too low (" + pollInterval + "), recommended minimum is 5");
		if(requestRateLimit == 0)
			// not relevant if encryption is used, but useful as a second line of defense if the key gets compromised
			logger.warn("requestRateLimit is 0, which is not recommended, because it allows the server to be used for UDP amplification attacks");
	}
}

function reloadMConfig(json){
	if(!json)
		json = getConfig();

	let measurements0 = [];
	if(Array.isArray(json.measurements)){
		let idCounter = 0;
		for(let m of json.measurements){
			if(typeof(m) == "object"){
				let type = m.type;
				if(typeof(type) != "string")
					throw new TypeError("'type' in a 'measurements' object must be a string");
				let name = m.name;
				if(name && typeof(name) != "string")
					throw new TypeError("'name' must be a string or empty");
				if(!measurers[type]){
					logger.debug("Loading measurer '" + type + "'");
					let measurer = require("./measurements/" + type);
					if(typeof(measurer.test) != "function")
						throw new Error("Invalid measurer '" + type + "': test is not a function");
					if(typeof(measurer.init) == "function"){
						measurer.init(logger.copy(type));
					}
					measurers[type] = measurer;
				}
				let interval;
				if(typeof(m.interval) == "number")
					interval = m.interval * 1000;
				else
					interval = 60000;
				let args = m.args || {};
				let saveHistory = m.saveHistory !== undefined ? !!m.saveHistory : true;
				let id = idCounter++;
				measurements0[id] = {id, name: name || args.target, type, interval, args, hideTarget: !!m.hideTarget, saveHistory, nonCritical: !!m.nonCritical};
			}else
				throw new TypeError("Values in 'measurements' must be objects");
		}
	}
	stopMeasurements();
	measurements = measurements0;

	thisNodeId = -1;
	let nodes0 = [];
	if(Array.isArray(json.nodes)){
		let idCounter = 0;
		const newNodeObj = (obj) => {
			let thisNode = !!obj.thisNode;
			let saveHistory = obj.saveHistory !== undefined ? !!obj.saveHistory : true;
			if(typeof(obj.address) != "string")
				throw new TypeError("'address' must be a string");
			if(obj.port && typeof(obj.port) != "number")
				throw new TypeError("'port' must be a number or empty");
			if(obj.name && typeof(obj.name) != "string")
				throw new TypeError("'name' must be a string or empty");
			let id = idCounter++;
			let nobj = {id, address: obj.address, port: obj.port || DEFAULT_PORT, name: obj.name || obj.address, hideAddress: !!obj.hideAddress, thisNode, saveHistory, nonCritical: !!obj.nonCritical};
			if(net.isIP(nobj.address) != 0){
				nobj.ipAddr = nobj.address;
				nobj.ipAddrTTL = -1;
			}
			nodes0[id] = nobj;
			if(thisNode){
				if(thisNodeId >= 0)
					logger.warn("Multiple nodes configured as thisNode: old " + thisNodeId + ", new " + id);
				thisNodeId = id;
			}
		};
		for(let n of json.nodes){
			if(typeof(n) == "string"){
				newNodeObj({address: n});
			}else if(typeof(n) == "object"){
				newNodeObj(n);
			}else
				throw new TypeError("Values in 'nodes' must be objects or strings");
		}
	}
	nodes = nodes0;
	for(let o of localNodesStatus){
		o.history = loadNodeHistory(o.id);
	}

	if(nodes.length < 1)
		logger.warn("No nodes are configured");
	if(thisNodeId < 0)
		logger.warn("No node configured as thisNode");

	let webpageOrder0 = [];
	if(Array.isArray(json.webpageOrder)){
		for(let o of json.webpageOrder){
			if(typeof(o) == "string")
				webpageOrder0.push(o);
			else if(typeof(o) == "object"){
				let type;
				if(o.type == "node" || o.type == "measurement")
					type = o.type;
				else
					throw new Error("webpageOrder: Invalid type '" + o.type + "'");
				if(typeof(o.id) != "number")
					throw new Error("webpageOrder: 'id' must be a number");
				let id = o.id;
				if(id < 0 || (type == "node" && id >= nodes.length) || (type == "measurement" && id >= measurements.length))
					throw new Error("webpageOrder: Invalid id");
				webpageOrder0.push({id, type});
			}else
				throw new Error("Values in 'webpageOrder' must be strings or objects");
		}
	}else{
		for(let i = 0; i < nodes.length; i++)
			webpageOrder0.push({type: "node", id: i});
		for(let i = 0; i < measurements.length; i++)
			webpageOrder0.push({type: "measurement", id: i});
	}
	webpageOrder = webpageOrder0;

	if(Array.isArray(json.webpageFootnotes))
		webpageFootnotes = json.webpageFootnotes;
	else
		webpageFootnotes = [];
}

function shutdown(status){
	setTimeout(() => {
		process.exit(2);
	}, 2000).unref();
	logger.info("Exiting");

	if(serverSocket)
		serverSocket.close();
	if(webserver)
		webserver.close();

	clearInterval(pollIntervalI);

	if(configFileWatcher && typeof(configFileWatcher.close) == "function")
		configFileWatcher.close();

	stopMeasurements();
	for(let m in measurers){
		try{
			if(typeof(measurers[m].close) == "function")
				measurers[m].close();
		}catch(e){
			logger.error("Error while closing measurer '" + m + "': " + e);
		}
	}

	logger.close();
	if(typeof(status) == "number")
		process.exitCode = status;
}


function startMeasurements(){
	for(let m of measurements){
		m.intervalI = setInterval(doMeasurement, m.interval, m.id);
	}
}

function stopMeasurements(){
	for(let m of measurements){
		clearInterval(m.intervalI);
	}
}


function onServerMessage(message, rinfo){
	let ca = rinfo.address;
	try{
		if(key)
			message = decrypt(message, key);

		let json;
		try{
			json = JSON.parse(message);
		}catch(e){
			logger.debug(ca + " sent invalid JSON");
			return;
		}

		const time = Date.now();
		const rateLimitMs = requestRateLimit * 1000;
		for(let c in requestClients){
			if(time - requestClients[c] > rateLimitMs)
				delete requestClients[c];
		}

		if(Array.isArray(json)){
			if(json.length <= 4){
				let res = [];
				for(let p of json){
					let msgtoken = p.msgtoken || null;
					res.push(handleRequest(time, ca, p).then((resp) => {
						resp.msgtoken = msgtoken;
						return resp;
					}));
				}
				Promise.all(res).then((msgs) => {
					let d = JSON.stringify(msgs);
					if(key)
						d = encrypt(d, key);
					logger.debug("Sending response to " + rinfo.address + ":" + rinfo.port + ": " + d.length + " bytes");
					serverSocket.send(d, rinfo.port, rinfo.address);
				}).catch((e) => {
					logger.warn("Error while processing a request from " + ca + ": " + e);
				});
			}
		}
	}catch(e){
		logger.warn("Error while processing request from " + ca + ": " + e);
	}
}

async function handleRequest(time, ca, json){
	let rlk = ca + "/" + json.action;
	if(requestClients[rlk]){
		logger.debug(ca + " rate limited");
		return {status: "rateLimit"};
	}else{
		requestClients[rlk] = time;
	}

	if(json.action == "fetchNodes"){
		logger.debug(ca + " requested fetchNodes");
		return {status: "success", nodes: publicNodesStatus};
	}else if(json.action == "fetchLocalNodes"){
		if(allowedStatusClients.includes(ca)){
			logger.info(ca + " requested fetchLocalNodes");
			return {status: "success", nodes: localNodesStatus};
		}else{
			return {status: "forbidden"};
		}
	}else if(json.action == "fetchLocalMeasurements"){
		if(allowedStatusClients.includes(ca)){
			logger.info(ca + " requested fetchLocalMeasurements");
			return {status: "success", nodes: localMeasurementStatus};
		}else{
			return {status: "forbidden"};
		}
	}else if(json.action == "fetchHistory"){
		let node = getNodeFromIPAddr(ca);
		if(node){
			let id = json.id;
			let start = json.start;
			let end = json.end;
			if(typeof(id) != "number" || typeof(start) != "number" || typeof(end) != "number"){
				return {status: "invalidArguments"};
			}
			let mh = !!json.mh; // whether requesting measurement or node history
			if(id < 0 || id >= (mh ? measurements.length : nodes.length)){
				return {status: "invalidId"};
			}
			delete requestClients[rlk]; // rate limiting is disabled because client seems to be another legitimate node (history data is often requested with short delay)
			logger.debug("Node '" + node.name + "' requested history of " + (mh ? "measurement" : "node") + " " + id + " from " + start + " to " + end);
			if(mh)
				return {status: "success", history: getMeasurementStatusLocal(id).history.filter(start, end).data};
			else
				return {status: "success", history: getNodeStatusLocal(id).history.filter(start, end).data};
		}else{
			return {status: "forbidden"};
		}
	}else if(json.action == "fetchStatusMessages"){
		logger.debug(ca + " requested fetchStatusMessages");
		let clientUpdated = parseInt(json.updated) || 0;
		try{
			await loadStatusMessages();
			if(clientUpdated < statusMessagesUpdated)
				return {status: "success", messages: statusMessages, updated: statusMessagesUpdated};
			else
				return {status: "success"};
		}catch(e){
			logger.error("Error while updating status messages: " + e);
			return {status: "serverError"};
		}
	}else{
		logger.debug(ca + " sent invalid action");
		return {status: "invalidAction"};
	}
}


async function loadStatusMessages(){
	const time = Date.now();
	if(time - lastStatusMsgPoll < 5000) // reduce filesystem io
		return;
	lastStatusMsgPoll = time;
	let stat = await fs.promises.lstat(statusMessageFile);
	if(statusMessagesUpdated >= stat.mtimeMs)
		return;
	let data = await fs.promises.readFile(statusMessageFile);
	let j = JSON.parse(data);
	if(!Array.isArray(j))
		throw new TypeError("status messages must be an array");
	statusMessages = j;
	statusMessagesUpdated = stat.mtimeMs;
}


async function doMeasurement(id){
	try{
		if(id < 0 || id >= measurements.length)
			throw new Error("Invalid measurement id " + id);
		if(ownVisibility < visibilityThreshold){
			logger.debug("Skipping measurement " + id + " because visibility is too low");
			return;
		}
		let m = measurements[id];
		let lms = getMeasurementStatusLocal(id);
		logger.debug("Performing measurement " + id + " ('" + m.type + "'/'" + m.name + "')");
		let res = await measurers[m.type].test(m.args);
		logger.debug("Measurement " + id + " result: " + res);
		if(typeof(res) == "number")
			lms.responseTime = res;
		else
			lms.responseTime = -1;
		res = !!res;
		lms.success = res;
		if(res)
			lms.lastSuccess = Date.now();

		if(m.saveHistory){
			lms.history.add(res, undefined, (start, end) => {
				fixHistory(start, end, true, id);
			});
			lms.history.optimize();
			saveMeasurementHistory(lms.id, lms.history);
		}
	}catch(e){
		logger.warn("Error while performing measurement " + id + ": " + e);
	}
}


async function fixHistory(start, end, mh, id){
	start = HMgr.htimeval(start);
	end = HMgr.htimeval(end);
	logger.debug("Fixing history of " + (mh ? "measurement" : "node") + " " + id + " from " + start + " to " + end);
	for(let n of nodes){
		if(n.thisNode || (!mh && n.id == id))
			continue;
		try{
			await fixHistoryWithNode(mh, id, n, start, end);
		}catch(e){
			logger.warn("Could not get history data from node '" + n.name + "': " + e);
		}
	}
}

function fixHistoryWithNode(mh, id, requestNode, start, end){
	return new Promise((resolve, reject) => {
		let ls = mh ? getMeasurementStatusLocal(id) : getNodeStatusLocal(id);
		nodeRequest(requestNode, 1000, "fetchHistory", {id: id, start, end, mh}).then((data) => {
			if(!Array.isArray(data.history))
				throw new Error("history is not an array");
			logger.debug("Merging new history data from '" + requestNode.name + "' (" + data.history.length + " entries) with history of " + (mh ? "measurement" : "node") + " " + id);
			ls.history.merge(data.history);
			resolve();
		}).catch(reject);
	});
}

function fixAllHistoryData(){
	for(let node of nodes){
		if(!node.saveHistory)
			continue;
		let lns = getNodeStatusLocal(node.id);
		lns.history.repair(fixHistory, false, node.id);
	}
	for(let m of measurements){
		if(!m.saveHistory)
			continue;
		let lms = getMeasurementStatusLocal(m.id);
		lms.history.repair(fixHistory, true, m.id);
	}
}

function setNodeVisibleBy(watcherNodeId, targetNodeId, visible, visibleTime){
	let lns = getNodeStatusLocal(targetNodeId);
	if(visibleTime > lns.lastSeen){
		lns.lastSeen = visibleTime;
		lns.lastSeenBy = watcherNodeId;
	}
	if(visible){
		if(!lns.visibility.includes(watcherNodeId))
			lns.visibility.push(watcherNodeId);
	}else{
		let index = lns.visibility.indexOf(watcherNodeId);
		if(index >= 0)
			lns.visibility.splice(index, 1);
	}
}


function pollAllNodes(){
	const time = Date.now();
	const timeout = pollInterval * 500;
	let ps = [];
	for(let node of nodes){
		if(node.thisNode){
			// we always see ourselves
			setNodeVisibleBy(node.id, node.id, true, time);
			let ts = getNodeStatusPublic(node.id);
			ts.lastSeen = time;
			ts.visible = true;
			resolveNodeAddress(node).catch(logger.warn);
		}else{
			ps.push(pollNode(node, timeout));
		}
	}
	let end = Promise.all(ps);
	end.then(() => {
		let htime = HMgr.htime();
		let visibleNodeCount = 0;
		for(let ns of publicNodesStatus){
			if(ns.visible)
				visibleNodeCount++;
		}
		ownVisibility = visibleNodeCount / nodes.length;
		logger.debug("Updating history data: time is " + htime + ", " + visibleNodeCount + " nodes visible, absolute visibility is " + Math.floor(ownVisibility * 100) + "%");
		for(let node of nodes){
			if(visibleNodeCount <= 1 && nodes.length > 1)
				continue;

			let lns = getNodeStatusLocal(node.id);
			let visibilityFraction = lns.visibility.length / visibleNodeCount;
			lns.visibilityFraction = visibilityFraction;
			let visible = visibilityFraction >= visibilityThreshold;

			if(node.saveHistory){
				lns.history.add(visible, htime, (start, end) => {
					fixHistory(start, end, false, node.id);
				});
				lns.history.optimize();
				saveNodeHistory(lns.id, lns.history);
			}
		}
	}).catch((e) => {
		logger.error("Internal error while polling nodes: " + e);
	});
}

async function pollNode(node, timeout){
	let nodeStatus = getNodeStatusPublic(node.id);
	try{
		logger.debug("Polling '" + node.name + "'");
		let ns = await getNodeStatus(node, timeout);
		const time = Date.now();
		nodeStatus.lastSeen = time;
		nodeStatus.visible = true;
		if(thisNodeId >= 0)
			setNodeVisibleBy(thisNodeId, node.id, true, time);
		for(let nd of ns.nodes){
			if(typeof(nd) != "object" || nd == null || typeof(nd.id) != "number" || nd.id < 0 || nd.id >= nodes.length || typeof(nd.lastSeen) != "number" || nd.lastSeen > time)
				continue;
			setNodeVisibleBy(node.id, nd.id, nd.visible, nd.lastSeen);
		}
		let sm = ns.statusMsg;
		if(sm.status != "success"){
			logger.warn("Status messages updated failed with status '" + sm.status + "'");
		}else if(typeof(sm.updated) == "number" && Array.isArray(sm.messages) && sm.updated > statusMessagesUpdated){
			statusMessages = sm.messages;
			statusMessagesUpdated = sm.updated;
		}else
			logger.debug("Status messages not modified");
	}catch(e){
		nodeStatus.visible = false;
		if(thisNodeId >= 0)
			setNodeVisibleBy(thisNodeId, node.id, false);
		for(let i = 0; i < nodes.length; i++) // node's visibility is unknown, so just assume that it sees nothing
			setNodeVisibleBy(node.id, i, false);
		logger.warn("Error while processing node data from '" + node.name + "': " + e);
	}
}

async function getNodeStatus(node, timeout){
	let data = await nodeRequestBulk(node, timeout, [{action: "fetchNodes"}, {action: "fetchStatusMessages", updated: statusMessagesUpdated}]);
	if(data[0].status != "success")
		throw "Received status '" + data[0].status + "' for fetchNodes";
	let nodes = data[0].nodes;
	if(!Array.isArray(nodes))
		throw "Response does not have 'nodes' array";
	return {nodes, statusMsg: data[1]};
}


async function nodeRequest(node, timeout, action, data = {}){
	let d = {};
	if(typeof(data) == "object"){
		for(let a in data)
			d[a] = data[a];
	}
	d.action = action;
	let res = (await nodeRequestBulk(node, timeout, [d]))[0];
	if(res.status != "success")
		throw "Received status '" + res.status + "'";
	return res;
}

function nodeRequestBulk(node, timeout, reqs){
	return new Promise((resolve, reject) => {
		if(!Array.isArray(reqs))
			throw new TypeError("'reqs' must be an array");

		for(let r of reqs){
			r.msgtoken = omzlib.util.randomHex16();
		}

		resolveNodeAddress(node).then(() => {
			let socket = dgram.createSocket("udp4");
			let timeoutWait;
			timeoutWait = setTimeout(() => {
				socket.close();
				reject("Did not receive valid response within specified timeout");
			}, timeout);
			timeoutWait.unref();

			socket.on("message", (message, rinfo) => {
				let msgname = "for node '" + node.name + "'/" + node.ipAddr + " (" + node.id + ") from " + rinfo.address + ":" + rinfo.port;
				logger.debug("Received message: " + msgname);

				if(key)
					message = decrypt(message, key);

				let json;
				try{
					json = JSON.parse(message);
					if(!Array.isArray(json))
						throw new TypeError("Expected array");
					if(json.length != reqs.length)
						throw new Error("Received number of answers (" + json.length + ") does not equal number of requests (" + reqs.length + ")");
				}catch(e){
					logger.warn("Received message " + msgname + " is invalid: " + e);
					return;
				}
				for(let i = 0; i < json.length; i++){
					if(json[i].msgtoken != reqs[i].msgtoken){
						logger.warn("Message token in received message [" + msgname + "] does not equal sent token in request " + i);
						return;
					}
				}

				socket.close();
				clearTimeout(timeoutWait);

				resolve(json);
			});
			socket.on("error", (e) => {
				logger.warn("Socket error to '" + node.name + "': " + e);
			});

			socket.bind({address: statusLocalAddress}, () => {
				socket.connect(node.port, node.ipAddr, () => {
					let pdata = JSON.stringify(reqs);
					if(key)
						socket.send(encrypt(pdata, key));
					else
						socket.send(pdata);
				});
			});

		}).catch(reject);
	});
}

async function resolveNodeAddress(node){
	if(!node.ipAddr || (node.ipAddrTTL >= 0 && Date.now() - node.ipAddrResolved > node.ipAddrTTL)){
		let nodeAddrs = await dns.promises.resolve4(node.address, {ttl: true});
		if(nodeAddrs.length < 1)
			throw "No IP address";
		let ttl = Math.max(30, nodeAddrs[0].ttl);
		node.ipAddr = nodeAddrs[0].address;
		node.ipAddrTTL = ttl * 1000;
		node.ipAddrResolved = Date.now();
		logger.info("Resolved IP address of node '" + node.name + "': " + node.ipAddr + " (TTL " + ttl + ")");
	}
}


function getNodeFromIPAddr(ipaddr){
	for(let n of nodes){
		if(n.ipAddr == ipaddr)
			return n;
	}
	return null;
}

function getNodeStatusPublic(id){
	if(id < 0 || id >= nodes.length)
		throw new Error("Invalid id: " + id);
	let ns = publicNodesStatus[id];
	if(!ns){
		ns = {id, lastSeen: 0, visible: false};
		publicNodesStatus[id] = ns;
	}
	return ns;
}

function getNodeStatusLocal(id){
	if(id < 0 || id >= nodes.length)
		throw new Error("Invalid id: " + id);
	let lns = localNodesStatus[id];
	if(!lns){
		lns = {id, lastSeen: 0, lastSeenBy: -1, visibility: [], visibilityFraction: 0, history: loadNodeHistory(id)};
		localNodesStatus[id] = lns;
	}
	return lns;
}

function getMeasurementStatusLocal(id){
	if(id < 0 || id >= measurements.length)
		throw new Error("Invalid id: " + id);
	let lms = localMeasurementStatus[id];
	if(!lms){
		lms = {id, success: false, lastSuccess: -1, responseTime: -1, history: loadMeasurementHistory(id, measurements[id].interval)};
		localMeasurementStatus[id] = lms;
	}
	return lms;
}

function loadNodeHistory(id){
	return HMgr.load(historySubDir + id, pollInterval * 2);
}

function saveNodeHistory(id, history){
	history.save(historySubDir + id);
}

function loadMeasurementHistory(id, interval){
	return HMgr.load(measurementHistorySubDir + id, Math.floor(interval / 500));
}

function saveMeasurementHistory(id, history){
	history.save(measurementHistorySubDir + id);
}


function encrypt(str, key){
	let pd = zlib.deflateSync(Buffer.from(str, "utf8"));
	let iv = crypto.randomBytes(key.length);
	let cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	let e1 = cipher.update(pd, "utf8");
	let e2 = cipher.final();
	let ctlen = e1.length + e2.length;
	let edata = Buffer.concat([iv, Buffer.from([ctlen & 0xff, (ctlen >>> 8) & 0xff]), e1, e2, cipher.getAuthTag()]);
	return edata;
}

function decrypt(data, key){
	let iv = data.slice(0, key.length);
	let cipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	let ctlen = data[iv.length] + (data[iv.length + 1] << 8);
	let ctstart = iv.length + 2;
	let ct = data.slice(ctstart, ctstart + ctlen);
	let mac = data.slice(ctstart + ctlen);
	cipher.setAuthTag(mac);
	let cd = Buffer.concat([cipher.update(ct), cipher.final()]);
	return zlib.inflateSync(cd).toString("utf8");
}



function http_client(req, res){
	http_respond(req, res).catch((e) => {
		logger.error("Error while handling HTTP request: " + e);
		writeResponse(res, 500, "Internal Server Error");
	});
}

async function http_respond(req, res){
	if(req.method != "GET"){
		writeResponse(res, 405, "Method Not Allowed");
		return;
	}
	let clientaddr = clientAddress(req);
	let surl = url.parse(req.url, true);
	logger.info("[http] " + clientaddr + " - " + req.method + " " + surl.pathname + " HTTP/" + req.httpVersion);
	if(surl.pathname.startsWith("/api/")){
		let endpoint = surl.pathname.substring(5).replace(/\//g, "_");
		let f = http_api[endpoint];
		if(typeof(f) == "function"){
			try{
				f(req, res, surl);
			}catch(e){
				logger.error("Error while running API endpoint '" + endpoint + "': " + e);
				writeJSONResponse(res, 500, {err: "InternalServerError"});
			}
		}else
			writeJSONResponse(res, 404, {err: "InvalidEndpoint"});
	}else{
		await http_respond_file(req, res, surl);
	}
}

async function http_respond_file(req, res, surl){
	const w404 = () => {
		writeResponse(res, 404, "Not Found");
	};
	let file = path.resolve(webroot + surl.pathname);
	if(!file.startsWith(webroot) || !fs.existsSync(file)){
		w404();
		return;
	}
	let stat = await fs.promises.lstat(file);
	if(stat.isDirectory()){
		file += "/index.html";
		if(!fs.existsSync(file)){
			w404();
			return;
		}
		stat = await fs.promises.lstat(file);
	}
	if(stat.isFile()){
		let data = await fs.promises.readFile(file);
		if(surl.pathname == "/"){
			let headAdd = "";
			if(useCustomStylesheet)
				headAdd += '<link rel="stylesheet" href="custom.css" />';
			for(let b of entryBuilders){
				if(typeof(b) == "string")
					headAdd += '<script src="builders/' + b + '.js"></script>';
			}
			let vars = {
				title: siteVars.title || "Server Status",
				icon: siteVars.icon || "/icon.png",
				description: siteVars.description || "",
				headAdd,
				version: VERSION,
				nodeName: thisNodeId >= 0 ? nodes[thisNodeId].name : "(none)"
			};
			vars.siteTitle = siteVars.siteTitle || vars.title;
			vars.siteIcon = siteVars.siteIcon || vars.icon;
			data = placeVariables(data, vars);
		}
		writeResponse(res, 200, data, {"content-type": getContentType(file)});
	}else
		w404();
}


const http_api = {

	config(req, res, surl){
		writeJSONResponse(res, 200, {content: webpageOrder, visibilityThreshold, footnotes: webpageFootnotes});
	},

	status_node(req, res, surl){
		let id = parseInt(surl.query.id);
		if(Number.isNaN(id) || id < 0 || id >= nodes.length){
			writeJSONResponse(res, 400, {err: "InvalidID"});
			return;
		}
		let historyStart = parseInt(surl.query.historyStart) - HMgr.timeStart;
		if(Number.isNaN(historyStart) || historyStart < 0)
			historyStart = 0;
		let historyEnd = parseInt(surl.query.historyEnd) - HMgr.timeStart;
		if(Number.isNaN(historyEnd) || historyEnd <= historyStart)
			historyEnd = HMgr.htime();
		let lns = getNodeStatusLocal(id);
		let n = nodes[id];
		writeJSONResponse(res, 200, {name: n.name, address: n.hideAddress ? null : (n.ipAddr || n.address), nonCritical: n.nonCritical,
			lastSeen: lns.lastSeen, lastSeenByName: lns.lastSeenBy >= 0 ? nodes[lns.lastSeenBy].name : null, visibilityFraction: lns.visibilityFraction,
			history: historyConvertToUTime(lns.history.filter(historyStart, historyEnd).data), success: lns.visibilityFraction >= visibilityThreshold});
	},

	status_measurement(req, res, surl){
		let id = parseInt(surl.query.id);
		if(Number.isNaN(id) || id < 0 || id >= measurements.length){
			writeJSONResponse(res, 400, {err: "InvalidID"});
			return;
		}
		let historyStart = parseInt(surl.query.historyStart) - HMgr.timeStart;
		if(Number.isNaN(historyStart) || historyStart < 0)
			historyStart = 0;
		let historyEnd = parseInt(surl.query.historyEnd) - HMgr.timeStart;
		if(Number.isNaN(historyEnd) || historyEnd <= historyStart)
			historyEnd = HMgr.htime();
		let lms = getMeasurementStatusLocal(id);
		let m = measurements[id];
		writeJSONResponse(res, 200, {name: m.name, type: m.type, target: m.hideTarget ? null : m.args.target, nonCritical: m.nonCritical,
			success: lms.success, lastSuccess: lms.lastSuccess, responseTime: lms.responseTime, history: historyConvertToUTime(lms.history.filter(historyStart, historyEnd).data)});
	},

	status_misc(req, res, surl){
		loadStatusMessages().then(() => {
			writeJSONResponse(res, 200, {messages: statusMessages, starting: Date.now() - initTime < pollInterval * 2000, absoluteVisibility: ownVisibility});
		}).catch((e) => {
			logger.error("Error while updating status messages: " + e);
			writeJSONResponse(res, 500, {err: "InternalServerError"});
		});
	},

	nodes(req, res, surl){
		writeJSONResponse(res, 200, publicNodesStatus);
	}
};

function historyConvertToUTime(history){
	for(let i = 0; i < history.length; i++){
		history[i] = history[i] + HMgr.timeStart;
	}
	return history;
}


function clientAddress(req){
	let xff = req.headers["x-forwarded-for"];
	if(xff)
		return xff.split(",")[0].trim();
	else
		return req.connection.remoteAddress + ":" + req.connection.remotePort;
}

function getContentType(filename){
	let ei = filename.lastIndexOf(".");
	if(ei < 0)
		return null;
	return {
		"html": "text/html; charset=utf-8",
		"css": "text/css; charset=utf-8",
		"js": "application/javascript; charset=utf-8",
		"json": "application/json"
	}[filename.substring(ei + 1)];
}

function placeVariables(data, vars){
	let out = [];
	let prevEnd = 0;
	let i = 0;
	while((i = data.indexOf(0x7b, i)) >= 0){
		i++;
		let endI = data.indexOf(0x7d, i);
		if(endI < 0)
			break;
		let name = data.slice(i, endI).toString();
		let v = vars[name];
		if(v === undefined)
			continue;
		out.push(data.slice(prevEnd, i - 1), Buffer.from(v));
		i = endI + 1;
		prevEnd = i;
	}
	if(prevEnd < data.length)
		out.push(data.slice(prevEnd));
	return Buffer.concat(out);
}


function writeJSONResponse(res, status, data, eheaders){
	if(typeof(eheaders) != "object")
		eheaders = {};
	if(!eheaders["content-type"])
		eheaders["content-type"] = "application/json";
	writeResponse(res, status, JSON.stringify(data), eheaders);
}

function writeResponse(res, status, data, eheaders){
	let headers = {"content-length": data.length, "server": BRAND};
	if(typeof(eheaders) == "object"){
		for(let h in eheaders)
			headers[h.toLowerCase()] = eheaders[h];
	}
	if(!headers["content-type"])
		headers["content-type"] = "text/plain; charset=utf-8";
	res.writeHead(status, headers);
	res.end(data);
}



function getSrcRoot(){
	let srcRootParts = process.argv[1].split(path.sep);
	srcRootParts.pop();
	let srcRoot = srcRootParts.join("/");
	if(srcRoot.length > 0)
		srcRoot += "/";
	return srcRoot;
}


