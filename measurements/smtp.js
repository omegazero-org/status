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

const net = require("net");

let logger;


function test(args){
	return new Promise((resolve, reject) => {
		if(typeof(args.target) != "string")
			throw new Error("'target' must be a string");

		let success = false;
		let startTime = Date.now();

		let socket = net.connect({host: args.target, port: args.port || 25});
		socket.on("error", (e) => {
			logger.warn("Socket error: " + e);
		});
		socket.on("close", () => {
			if(success)
				resolve(Date.now() - startTime);
			else
				resolve(false);
		});
		socket.on("data", (d) => {
			d = d.toString();
			let eol = d.indexOf("\r\n");
			if(eol >= 0){
				let rp = d.substring(0, eol).split(" ");
				let status = parseInt(rp[0]);
				if(Number.isNaN(status) || status < 200 || status > 299){
					logger.warn("Negative status from " + args.target + ": " + status);
				}else
					success = true;
			}
			socket.end();
		});
	});
}


module.exports.init = (l) => {
	logger = l;
};
module.exports.test = test;

