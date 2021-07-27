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

const dns = require("dns");
const net = require("net");

let logger;


async function test(args){
	if(typeof(args.target) != "string")
		throw new Error("'target' must be a string");
	if(typeof(args.hostname) != "string")
		throw new Error("'hostname' must be a string");
	if(!Array.isArray(args.expected))
		args.expected = undefined;
	if(!args._resolver){
		let resolver = new dns.Resolver({timeout: args.timeout || 3000});
		let target = args.targetIpAddr || args.target;
		if(net.isIP(target) == 0){
			let res = await dns.promises.resolve4(target);
			if(res.length < 1)
				throw new Error("Unable to resolve '" + target + "'");
			target = res[0];
		}
		if(net.isIPv6(target))
			target = "[" + target + "]";
		if(typeof(args.port) == "number")
			target += ":" + args.port;
		resolver.setServers([target]);
		args._resolver = resolver;
	}
	let rrtype = args.rrtype || "A";
	logger.debug("Requesting " + args.hostname + " IN " + rrtype + " from " + args.target);
	try{
		let start = Date.now();
		await dnsResolve(args._resolver, args.hostname, rrtype, args.expected);
		return (Date.now() - start) || 1;
	}catch(e){
		logger.warn("DNS request failed: " + e);
		return 0;
	}
}

function dnsResolve(resolver, hostname, rrtype, expected){
	return new Promise((resolve, reject) => {
		resolver.resolve(hostname, rrtype, (err, records) => {
			if(err){
				reject(err);
			}else{
				let rrs = rrToStringArray(rrtype, records);
				let eq;
				if(expected === undefined){
					eq = true;
				}else if(expected.length == rrs.length){
					eq = true;
					for(let i = 0; i < rrs.length; i++){
						if(expected[i] != rrs[i]){
							eq = false;
							break;
						}
					}
				}else
					eq = false;
				if(eq)
					resolve();
				else
					reject("Answers do not equal expected answers");
			}
		});
	});
}

function rrToStringArray(rrtype, data){
	let objprop = null;
	if(rrtype == "MX")
		objprop = "exchange";
	else if(rrtype == "SOA")
		objprop = "hostmaster";
	else if(rrtype == "SRV")
		objprop = "name";
	if(objprop){
		for(let i = 0; i < data.length; i++){
			data[i] = data[i][objprop];
		}
	}else if(rrtype == "TXT"){
		for(let i = 0; i < data.length; i++){
			data[i] = data[i].join("");
		}
	}
	return data;
}


module.exports.init = (l) => {
	logger = l;
};
module.exports.test = test;

