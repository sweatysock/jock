// Variables that the supervisor can control ofr all clients and their default values:
globalMute = false;							// Mute all clients
gateDelay = 40;								// the delay in mS on all clients for mic gate staying open
venueSize = 0;								// global venue size which impacts the attenuation applied to audience sound
perfChannel = 0;							// performer channel on this (venue) server
perfLevel = 1;								// control performer Mic level directly from console
noisethreshold = 0.02;							// mic gate threshold to remove background noise

// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {
	console.log('socket connected!');
	socketConnected = true;
	socketIO.emit("superHi"); 					// Say hi to the server so it adds us to its list of supervisors
	sendCommands();							// Send server our command settings: reconnect may be due to server reset
	sendPerformer();						// Send the performer channel for the same reason. Server reset forgets all
});

socketIO.on('s', function (data) { 
	document.title = data.server;
	document.getElementById("idle").innerHTML = data["idle"];
	document.getElementById("upstream").innerHTML = data["upstream"];
	document.getElementById("downstream").innerHTML = data["downstream"];
	document.getElementById("genMix").innerHTML = data["genMix"];
	document.getElementById("clients").innerHTML = data["clients"];
	document.getElementById("inC").innerHTML = data["in"];
	document.getElementById("out").innerHTML = data["out"];
	document.getElementById("overflows").innerHTML = data["overflows"];
	document.getElementById("shortages").innerHTML = data["shortages"];
	document.getElementById("forcedMixes").innerHTML = data["forcedMixes"];
	document.getElementById("cbs").innerHTML = data["cbs"];
	document.getElementById("cic").innerHTML = data["cic"];
	document.getElementById("pacClass").innerHTML = data["pacClass"];
	document.getElementById("upServer").innerHTML = data["upServer"];
	document.getElementById("upIn").innerHTML = data["upIn"];
	document.getElementById("upOut").innerHTML = data["upOut"];
	document.getElementById("perf").innerHTML = "*"+data["perf"]+"*";
	document.getElementById("perfQ").innerHTML = data["perfQ"];
	document.getElementById("perfIn").innerHTML = data["perfIn"];
	document.getElementById("perfStr").innerHTML = data["perfStr"];
	document.getElementById("perfShort").innerHTML = data["perfShort"];
});

socketIO.on('disconnect', function () {
	console.log('socket disconnected!');
	socketConnected = false;
});

// Set up behaviour for UI
//
document.addEventListener('DOMContentLoaded', function(event){
	let muteBtn = document.getElementById('muteBtn');
	let micOpenBtn = document.getElementById('micOpenBtn');
	if (globalMute) {
		muteBtn.style.visibility = "hidden";
		micOpenBtn.style.visibility = "visible";
	} else {
		muteBtn.style.visibility = "visible";
		micOpenBtn.style.visibility = "hidden";
	}
	muteBtn.onclick = ( (e) => {
		globalMute = true;
		sendCommands();
		muteBtn.style.visibility = "hidden";
		micOpenBtn.style.visibility = "visible";
	});
	micOpenBtn.onclick = ( (e) => {
		globalMute = false;
		sendCommands();
		muteBtn.style.visibility = "visible";
		micOpenBtn.style.visibility = "hidden";
	});
	let gateDelayEntry = document.getElementById('gateDelayEntry');
	gateDelayEntry.innerHTML = gateDelay;
	gateDelayEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			gateDelay = parseFloat(gateDelayEntry.innerHTML);
			sendCommands();
			e.preventDefault();
		}
	});
	let venueSizeEntry = document.getElementById('venueSizeEntry');
	venueSizeEntry.innerHTML = venueSize;
	venueSizeEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			venueSize = parseFloat(venueSizeEntry.innerHTML);
			sendCommands();
			e.preventDefault();
		}
	});
	let perfEntry = document.getElementById('perfEntry');
	perfEntry.innerHTML = perfChannel;
	perfEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			perfChannel = parseFloat(perfEntry.innerHTML);
			sendPerformer();
			e.preventDefault();
		}
	});
	let perfLevelEntry = document.getElementById('perfLevelEntry');
	perfLevelEntry.innerHTML = perfLevel;
	perfLevelEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			perfLevel = parseFloat(perfLevelEntry.innerHTML);
			sendCommands();
			e.preventDefault();
		}
	});
	let noiseThresholdEntry = document.getElementById('noiseThresholdEntry');
	noiseThresholdEntry.innerHTML = noisethreshold;
	noiseThresholdEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			noisethreshold = parseFloat(noiseThresholdEntry.innerHTML);
			sendCommands();
			e.preventDefault();
		}
	});
});

function sendCommands() {
	socketIO.emit("commands",
	{							
		mute		: globalMute,
		gateDelay	: gateDelay,
		venueSize	: venueSize,
		perfLevel	: perfLevel,
		noiseThreshold	: noisethreshold,
	});
}

function sendPerformer() {
	socketIO.emit("setPerformer",
	{
		channel: perfChannel,
	});
}


