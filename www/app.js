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


(function(){


	const DAY_LEN = 86400;
	const RELOAD_INTERVAL = 60;

	const historyLenDays = 120;
	const historyLen = historyLenDays * DAY_LEN;
	var historyStart;
	var historyData;

	var visibilityThreshold;
	var footnotes;
	var nodeStarting;
	var maintenance;

	var entryBuilders = {};

	var mainEl;
	var hoverBoxEl;

	function init(){
		mainEl = document.getElementById("main");
		hoverBoxEl = document.getElementById("hoverBox");

		const lerr = (e) => {
			mainEl.innerHTML = err("An error has occurred: " + e);
		};
		apiRequest("config").then((config) => {
			visibilityThreshold = config.visibilityThreshold;
			footnotes = config.footnotes;
			loadMisc().then((status) => {
				createPage(config.content, status.messages);
				jumpToAnchor();
				loadEntries();
			});
		});
		mainEl.innerHTML = lw("Loading");

		setInterval(reload, RELOAD_INTERVAL * 1000);
	}

	function createPage(content, messages){
		let ihtml = '<div id="header"></div>';
		ihtml += '<div class="category">';
		if(Array.isArray(content)){
			for(let c of content){
				if(typeof(c) == "object"){
					let id = c.type + '-' + c.id;
					ihtml += '<div id="entry-' + id + '" class="entry entry-pending">' + lw('Loading <span style="opacity: 0.5;">' + id + '</span>') + '</div>';
				}else if(typeof(c) == "string"){
					ihtml += '</div><div class="category"><div id="' + c.replace(/ /g, "_") + '" class="category-title">' + c + '</div>';
				}
			}
		}else
			console.error("content is not an array");
		ihtml += '</div>';
		mainEl.innerHTML = ihtml;
		loadHeader(messages);
		let footnotesStr = "All times are UTC";
		if(Array.isArray(footnotes)){
			for(let f of footnotes)
				footnotesStr += " | " + f;
		}
		document.getElementById("footnotes").innerHTML = footnotesStr;
	}

	function jumpToAnchor(){
		let h = window.location.hash;
		if(!h || h.length < 1)
			return;
		h = h.substring(1);
		let el = document.getElementById(h);
		if(el)
			el.scrollIntoView();
	}


	function reload(){
		loadMisc().then((status) => {
			loadHeader(status.messages);
			loadEntries();
		});
	}

	function loadMisc(){
		return new Promise((resolve, reject) => {
			apiRequest("status/misc").then((status) => {
				nodeStarting = status.starting;
				maintenance = Array.isArray(status.messages) && status.messages.includes("!maintenance");
				document.getElementById("footnotes2").innerHTML = " | Absolute Visibility: " + Math.floor(status.absoluteVisibility * 100) + "%";
				resolve(status);
			}).catch(reject);
		});
	}

	function loadHeader(messages){
		let header = document.getElementById("header");
		let ihtml = '<div id="statusBox" class="msgBox"><span id="time">' + getFormattedUTCDate() + '</span>';
		let statusSummary = document.getElementById("statusSummary"); // get previous statusSummary if available
		if(statusSummary)
			ihtml += '<span id="statusSummary" class="' + statusSummary.className + '">' + statusSummary.innerHTML + '</span>';
		else
			ihtml += '<span id="statusSummary"></span>';
		if(Array.isArray(messages)){
			if(messages.length > 0){
				ihtml += '<div class="hsep"></div>';
				for(let m of messages){
					if(typeof(m) != "object")
						continue;
					ihtml += '<div class="statusMsg"><span id="time">' + (m.time ? getFormattedUTCDate(m.time * 1000) : "") + '</span><span class="statusMsgContent">' + m.msg + '</span></div>';
				}
			}
		}
		ihtml += '</div>';
		header.innerHTML = ihtml;
	}

	function loadEntries(){
		historyStart = (Date.now() / 1000) - historyLen;
		historyStart += DAY_LEN - (historyStart % DAY_LEN);
		historyData = {};
		let w = [];
		let els = document.getElementsByClassName("entry");
		for(let e of els){
			let p = e.id.split("-");
			if(p.length < 3)
				continue;
			w.push(loadEntryContent(p[1], p[2], e));
		}
		Promise.all(w).then((s) => {
			let successCount = s.filter(Boolean).length;
			let statusSummary = document.getElementById("statusSummary");
			if(nodeStarting){
				statusSummary.className = "starting";
				statusSummary.innerHTML = '<span title="The node you are connected to just started and may take some time to display correct data">Node is starting</span>';
			}else if(maintenance){
				statusSummary.className = "maintenance";
				statusSummary.innerHTML = 'Ongoing Maintenance';
			}else{
				let p = successCount / s.length;
				if(p >= 1){
					statusSummary.className = "good";
					statusSummary.innerHTML = "All Systems Operational";
				}else if(p > .5){
					statusSummary.className = "bad";
					statusSummary.innerHTML = "Partial Outage";
				}else{
					statusSummary.className = "verybad";
					statusSummary.innerHTML = "Major Outage";
				}
			}
		});
	}

	function loadEntryContent(type, id, element){
		return new Promise((resolve, reject) => {
			const se = (msg) => {
				element.innerHTML = err("Error while loading data for '" + type + "-" + id + "': " + msg);
			};
			apiRequest("status/" + type + "?id=" + id + "&historyStart=" + historyStart).then((data) => {
				resolve(!!data.success || data.nonCritical);
				if(data.err){
					se("Received error from server: " + data.err);
				}else{
					try{
						element.innerHTML = genEntryContent(type, data);
						element.classList.remove("entry-pending");
						addHistoryEventHandlers(element);
					}catch(e){
						se(e);
					}
				}
			}).catch((e) => {
				se(e);
			});
		});
	}

	function genEntryContent(type, data){
		if(type == "node")
			return genEntryContentNode(data);
		else if(type == "measurement")
			return genEntryContentMeasurement(data);
		else
			throw "Invalid type: '" + type + "'";
	}

	function genEntryContentNode(data){
		let ihtml = '<span title="critical: ' + !data.nonCritical + '" class="title">' + data.name + '</span>';
		if(data.address && data.address != data.name)
			ihtml += '<span title="The address of this node" class="help subtitle">' + data.address + '</span>';
		ihtml += '<div class="currentStatus"><span title="The percentage of nodes that claim to see this node of all nodes seen by the node you are connected to" class="help visibility ';
		if(data.visibilityFraction > .95)
			ihtml += "visibility-high";
		else if(data.visibilityFraction > .7)
			ihtml += "visibility-medium";
		else if(data.visibilityFraction > .3)
			ihtml += "visibility-low";
		ihtml += '">' + Math.floor(data.visibilityFraction * 100) + '% visibility</span><span class="statusDetails">Last seen by ' + (data.lastSeenByName || "(none)")
			+ ' at ' + (data.lastSeen > 0 ? getFormattedUTCDate(data.lastSeen) : "(never)") + '</span></div>';
		if(data.history && data.history.length > 0)
			ihtml += genHistory(data.history, true);
		return ihtml;
	}


	function genEntryContentMeasurement(data){
		let ihtml = '<span class="title">' + data.name + '</span>';
		ihtml += '<span class="subtitle">' + data.type + (data.target && data.target != data.name ? (" - " + data.target) : "") + '</span>';
		ihtml += '<div class="currentStatus">';
		let builder = entryBuilders[data.type] || entryBuilders.default;
		if(builder)
			ihtml += builder.build(data);
		ihtml += '</div>';
		if(data.history && data.history.length > 0)
			ihtml += genHistory(data.history);
		return ihtml;
	}

	registerEntryBuilder("default", {
		build: function(data){
			let ihtml = '<span class="visibility ';
			if(data.success)
				ihtml += "visibility-high";
			ihtml += '">' + (data.success ? "Available" : "Unavailable") + '</span>';
			ihtml += '<span class="statusDetails">Last reachable ' + (data.lastSuccess > 0 ? getFormattedUTCDate(data.lastSuccess) : "(never)");
			if(data.success && data.responseTime >= 0)
				ihtml += '<br />Response time: ' + data.responseTime + 'ms';
			ihtml += '</span>';
			return ihtml;
		}
	});


	function genHistory(history, node = false){
		let hhtml = '<div class="history">';
		let his = [];
		let hisI = 0;
		for(let i = 0; i < historyLenDays; i++)
			his[i] = {timeUp: 0, timeDown: 0, downTimes: [], startTime: historyStart + i * DAY_LEN};
		for(let i = 0; i < history.length; i += 2){
			const status = !!(history[i] & 1);
			const prop = status ? "timeUp" : "timeDown";
			const start = htimeval(history[i]) - historyStart;
			const end = htimeval(history[i + 1]) - historyStart;
			const startDayTime = Math.max(start % DAY_LEN, 0);
			const endDayTime = end % DAY_LEN;
			const startDay = Math.max(Math.floor(start / DAY_LEN), 0);
			const endDay = Math.min(Math.floor(end / DAY_LEN), historyLenDays);
			if(endDay < startDay)
				throw "endDay is lower than startDay";
			if(startDay == endDay){
				if(endDayTime < startDayTime)
					throw "endDayTime is lower than startDayTime";
				his[startDay][prop] += endDayTime - startDayTime;
				if(!status)
					his[startDay].downTimes.push({start: startDayTime, end: endDayTime});
			}else{
				his[startDay][prop] += DAY_LEN - startDayTime;
				his[endDay][prop] += endDayTime;
				if(!status){
					his[startDay].downTimes.push({start: startDayTime, end: DAY_LEN});
					his[endDay].downTimes.push({start: 0, end: endDayTime});
				}
				for(let j = startDay + 1; j <= endDay - 1; j++){
					his[j][prop] += DAY_LEN;
					if(!status)
						his[j].downTimes.push({start: 0, end: DAY_LEN});
				}
			}
		}
		let totalKnownTime = 0;
		let totalUptime = 0;
		for(let h of his){
			let htk = h.timeUp + h.timeDown;
			h.uptime = htk > 0 ? (h.timeUp / htk) : -1;
			totalKnownTime += htk;
			totalUptime += h.timeUp;
		}
		let uptime = totalUptime / totalKnownTime;
		hhtml += '<span title="Uptime over the last ' + historyLenDays + ' days'
			+ (node ? ("\nA node is considered 'up' at any point in time when its visibility is " + (visibilityThreshold * 100) + "% or higher") : "")
			+ '" class="help uptime-value"' + getUptimeColorStyleOverride(uptime) + '>' + uptimeStr(uptime) + '</span>';
		hhtml += '<div class="history-content">';
		let idc = 0;
		for(let h of his){
			let id = Math.random().toString(16).substring(2, 10) /* random string */ + "-" + (idc++);
			hhtml += '<div id="' + id + '" class="uptime-tile"' + getUptimeColorStyleOverride(h.uptime, true) + '></div>';
			historyData[id] = h;
		}
		hhtml += '</div></div>';
		return hhtml;
	}

	function addHistoryEventHandlers(element){
		let tiles = element.getElementsByClassName("uptime-tile");
		for(let e of tiles){
			e.addEventListener("mouseenter", onTileMouseEnter);
			e.addEventListener("mouseleave", onTileMouseLeave);
		}
	}


	function onTileMouseEnter(event){
		let el = event.target;
		let h = historyData[el.id];
		if(!h)
			return;
		let ihtml = '<div class="box-title">' + getFormattedUTCDay(h.startTime * 1000) + '</div><span class="uptime-value"'
			+ getUptimeColorStyleOverride(h.uptime) + '>' + uptimeStr(h.uptime) + ' uptime</span>';
		for(let d of h.downTimes){
			if(d.end - d.start > 60) // down for more than 1 minute
				ihtml += '<div class="down-time">' + getFormattedUTCTime(d.start * 1000) + ' - ' + getFormattedUTCTime(d.end * 1000) + '</div>';
		}
		let pos = el.getBoundingClientRect();
		hoverBoxEl.style.bottom = (window.innerHeight - (pos.top - 5)) + "px";
		if(pos.left > window.innerWidth / 2){
			hoverBoxEl.style.right = (window.innerWidth - pos.right - pos.width * 2) + "px";
			hoverBoxEl.style.left = "";
		}else{
			hoverBoxEl.style.left = pos.left + "px";
			hoverBoxEl.style.right = "";
		}
		hoverBoxEl.innerHTML = ihtml;
		hoverBoxEl.style.display = "block";
	}

	function onTileMouseLeave(){
		hoverBoxEl.style.display = "none";
	}


	function registerEntryBuilder(name, builder){
		if(!entryBuilders[name] && typeof(builder.build) == "function"){
			entryBuilders[name] = builder;
			return true;
		}else
			return false;
	}


	function apiRequest(endpoint){
		return new Promise((resolve, reject) => {
			fetch("api/" + endpoint).then((res) => {
				return res.json();
			}).then(resolve).catch(reject);
		});
	}


	function lw(msg){
		return '<div class="loading-wrap"><div class="loading-wheel"></div>' + msg + '</div>';
	}

	function err(msg){
		return '<div class="error">' + msg + '</div>';
	}

	function htimeval(v){
		return v - (v & 1);
	}

	function uptimeStr(uptime){
		if(uptime >= 0)
			return (Math.round(uptime * 100000) / 1000) + "%";
		else
			return "(unknown)";
	}

	function pad(str, width, c) {
		c = c || '0';
		str = str + '';
		return str.length >= width ? str : (new Array(width - str.length + 1).join(c) + str);
	}

	function getUptimeColor(uptime){
		let rcolor = uptime < 0.8 ? 255 : 255 - Math.round(Math.exp(-((1 - uptime) * 5) * 5) * 255);
		let color = uptime > 0.8 ? 255 : Math.round(Math.exp(-(1 - uptime * 1.25) * 5) * 255);
		return "rgb(" + rcolor + ", " + color + ", 0)";
	}

	function getUptimeColorStyleOverride(uptime, background = false){
		return uptime >= 0 ? (' style="' + (background ? "background-" : "") + 'color: ' + getUptimeColor(uptime) + ';"') : "";
	}

	function getFormattedUTCDate(time = Date.now()){ /* format: YYYY/MM/DD HH:mm:ss */
		let date = new Date(time);
		return date.getUTCFullYear() + "/" + pad(date.getUTCMonth() + 1, 2) + "/" + pad(date.getUTCDate(), 2) + " "
			+ pad(date.getUTCHours(), 2) + ":" + pad(date.getUTCMinutes(), 2) + ":" + pad(date.getUTCSeconds(), 2);
	}

	function getFormattedUTCDay(time = Date.now()){ /* format: YYYY/MM/DD */
		let date = new Date(time);
		return date.getUTCFullYear() + "/" + pad((date.getUTCMonth() + 1), 2) + "/" + pad(date.getUTCDate(), 2);
	}

	function getFormattedUTCTime(time = Date.now()){ /* format: HH:mm:ss */
		let date = new Date(time);
		return pad(date.getUTCHours(), 2) + ":" + pad(date.getUTCMinutes(), 2) + ":" + pad(date.getUTCSeconds(), 2);
	}


	window.registerEntryBuilder = registerEntryBuilder;

	window.addEventListener("pageshow", init);

})();

