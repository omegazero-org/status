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

const http = require("http");
const https = require("https");
const url = require("url");

let logger;


async function test(args){
	if(typeof(args.target) != "string")
		throw new Error("'target' must be a string");
	if(args.content !== undefined && !Buffer.isBuffer(args.content))
		args.content = Buffer.from(args.content);

	let turl = url.parse(args.target);
	let mod;
	if(turl.protocol == "http:")
		mod = http;
	else if(turl.protocol == "https:")
		mod = https;
	else
		throw new Error("Invalid protocol '" + turl.protocol + "'");
	let options = {
		hostname: turl.hostname,
		port: turl.port,
		path: turl.path,
		method: args.method || "GET",
		headers: args.headers || null
	};
	logger.debug(options.method + " " + turl.protocol + "//" + options.hostname + ":" + options.port + options.path);
	try{
		let start = Date.now();
		await requestP(mod, options, args.status, args.content);
		return (Date.now() - start) || 1;
	}catch(e){
		logger.warn("HTTP request failed: " + e);
		return 0;
	}
}

function requestP(mod, options, status, content){
	return new Promise((resolve, reject) => {
		let req = mod.request(options, (res) => {
			let len = 0;
			let dataArray = [];
			res.on("data", (d) => {
				dataArray.push(d);
				len += d.length;
				if(len > 0x100000){
					req.abort();
					reject("Response too large");
				}
			});
			res.on("end", () => {
				if(req.aborted){
					reject("Request aborted");
					return;
				}
				if(!isStatusAllowed(res.statusCode, status)){
					reject("Disallowed status code: " + res.statusCode);
					return;
				}
				if(content !== undefined && !Buffer.concat(dataArray).equals(content)){
					reject("Content does not match");
					return;
				}
				resolve();
			});
		});
		req.on("error", reject);
		req.end();
	});
}

function isStatusAllowed(received, cstatus){
	if(typeof(cstatus) == "number"){
		return received == cstatus;
	}else if(Array.isArray(cstatus)){
		return cstatus.includes(received);
	}else
		return received >= 200 && received <= 299;
}


module.exports.init = (l) => {
	logger = l;
};
module.exports.test = test;

