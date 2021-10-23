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

const fs = require("fs");

class HMgr{

	constructor(history, missingDataLen = 30){
		this.history = history;
		this.missingDataLen = missingDataLen;
	}


	historyBinarySearch(time){
		if(time & 1)
			time--;
		let l = 0;
		let r = this.history.length;
		while(l <= r){
			let m = Math.floor((l + r) * 0.5);
			let val = HMgr.htimeval(this.history[m]);
			if(val < time){
				l = m + 1;
			}else if(val > time){
				r = m - 1;
			}else
				return m;
		}
		// go to first lower value
		let i = Math.min(this.history.length - 1, l);
		while(i > 0 && HMgr.htimeval(this.history[i]) > time)
			i--;
		return i;
	}

	filter(start, end){
		let startI = this.historyBinarySearch(start);
		startI -= (startI & 1);
		let endI = this.historyBinarySearch(end);
		endI += (endI & 1);
		return {start: startI, end: endI, data: this.history.slice(startI, endI)};
	}

	merge(newHistoryData){
		for(let tfi = 0; tfi < newHistoryData.length / 2; tfi++){
			let hi = tfi * 2;
			let tfstart = newHistoryData[hi];
			let tfend = newHistoryData[hi + 1];
			if((tfstart & 1) != (tfend & 1)){
				HMgr.logger.warn("Cannot merge time frame " + tfi + " because status is inconsistent");
				continue;
			}
			this.mergeTimeFrame(HMgr.htimeval(tfstart), HMgr.htimeval(tfend), !!(tfstart & 1));
		}
		this.optimize();
	}

	mergeTimeFrame(start, end, status){
		for(let i = 1; i < this.history.length; i += 2){
			let prevEnd = HMgr.htimeval(this.history[i]);
			let nextStart = HMgr.htimeval(this.history[i + 1]);
			if(this.isHistoryHole(prevEnd, nextStart)){
				let tfstart = Math.max(start, prevEnd);
				let tfend = Math.min(end, nextStart);
				if(tfstart < tfend){
					this.history.splice(i + 1, 0, tfstart + status, tfend + status);
					i += 2;
				}
			}
		}
		let hs = HMgr.htimeval(this.history[0]);
		if(this.history.length < 1 || start < hs){
			hs = hs || end;
			this.history.unshift(start + status, Math.min(hs, end) + status);
		}
		let he = HMgr.htimeval(this.history[this.history.length - 1]);
		if(end > he){
			this.history.push(Math.max(he, start) + status, end + status);
		}
	}

	optimize(){
		const history = this.history;
		for(let i = 0; i < history.length - 2; i++){
			if(i < 0)
				continue;
			if(i & 1){
				let prevEnd = HMgr.htimeval(history[i]);
				let nextStart = HMgr.htimeval(history[i + 1]);
				if(prevEnd < nextStart && !this.isHistoryHole(prevEnd, nextStart)){
					history[i] = nextStart + (history[i] & 1);
				}else if(prevEnd > nextStart){
					HMgr.logger.warn("Detected that history is out of order at index " + i + " (" + prevEnd + " > " + nextStart + ")");
					history[i + 1] = prevEnd + (history[i + 1] & 1);
				}
			}
			if(history[i] == history[i + 1]){
				history.splice(i, 2);
				i -= 2;
			}
		}
	}

	add(status, htime = HMgr.htime(), missingDataCallback){
		const history = this.history;
		if(status)
			htime++; // set lowest bit to mark it being up

		let lastHVal = history[history.length - 1];

		if(!lastHVal || this.isHistoryHole(lastHVal, htime)){ // last time frame is too far in the past, create new one
			history.push(htime);
			history.push(htime);
			if(lastHVal && typeof(missingDataCallback) == "function")
				missingDataCallback(lastHVal, htime);
		}else{
			if(status){
				if(lastHVal & 1){
					history[history.length - 1] = htime;
				}else{
					history.push(lastHVal + 1);
					history.push(htime);
				}
			}else{
				if(lastHVal & 1){
					history.push(lastHVal - 1);
					history.push(htime);
				}else{
					history[history.length - 1] = htime;
				}
			}
		}
	}

	repair(missingDataCallback, ...args){
		for(let i = 1; i < this.history.length; i += 2){
			let prevEnd = HMgr.htimeval(this.history[i]);
			let nextStart = HMgr.htimeval(this.history[i + 1]);
			if(this.isHistoryHole(prevEnd, nextStart)){
				missingDataCallback(prevEnd, nextStart, ...args);
			}
		}
	}


	isHistoryHole(prevEnd, nextStart){
		return nextStart - prevEnd > this.missingDataLen;
	}

	get data(){
		return this.history;
	}

	get length(){
		return this.history.length;
	}


	save(file){
		let data = Buffer.alloc(this.history.length * 6);
		let di = 0;
		for(let i = 0; i < this.history.length; i++){
			let val = this.history[i];
			data[di++] = 0;
			data[di++] = val & 0xff;
			data[di++] = val.shr(8) & 0xff;
			data[di++] = val.shr(16) & 0xff;
			data[di++] = val.shr(24) & 0xff;
			data[di++] = val.shr(32) & 0xff;
		}
		fs.writeFileSync(file, data);
	}


	static load(file, missingDataLen){
		if(fs.existsSync(file)){
			let data = fs.readFileSync(file);
			let hdata = [];
			for(let i = 0; i < data.length; ){
				if(data.length - i < 6){
					HMgr.logger.warn("Skipping trailing bytes in history data");
					break;
				}
				i++;
				// little endian format, 5 bytes each; least significant bit represents if the node was down (0, 1 if up) since or until the represented time (time frame)
				let val = data[i++] + data[i++].shl(8) + data[i++].shl(16) + data[i++].shl(24) + data[i++].shl(32);
				hdata.push(val);
			}
			return new HMgr(hdata, missingDataLen);
		}
		return new HMgr([], missingDataLen);
	}

	static htime(){
		return HMgr.htimeval(Math.floor(Date.now() / 1000) - HMgr.timeStart);
	}

	static htimeval(v){
		return v - (v & 1);
	}

	static setLogger(logger){
		HMgr.logger = logger;
	}
}

HMgr.timeStart = 1609459200;


module.exports = HMgr;

